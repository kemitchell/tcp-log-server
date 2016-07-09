var asyncQueue = require('async.queue')
var concatStream = require('concat-stream')
var duplexJSON = require('duplex-json-stream')
var endOfStream = require('end-of-stream')
var stringify = require('json-stable-stringify')
var through2 = require('through2')
var uuid = require('uuid')

var LOG_NAME = 'log'

module.exports = function factory (serverLog, logs, blobs, emitter, hashFunction) {
  return function tcpConnectionHandler (connection) {
    // Conncetions will be held open long-term, and may site idle.  Enable
    // keep-alive to keep them from dropping.
    connection.setKeepAlive(true)

    // Sert up a child log for just this connection, identified by UUID.
    var connectionLog = serverLog.child({connection: uuid.v4()})
    connectionLog.info({
      event: 'connected',
      address: connection.remoteAddress,
      port: connection.removePort
    })

    // Log end-of-connection events.
    connection
    .once('end', function () { connectionLog.info({event: 'end'}) })
    .once('error', function (error) { connectionLog.error(error) })
    .once('close', function (error) {
      connectionLog.info({event: 'close', error: error})
    })

    // Send newline-delimited JSON back and forth across the connection.
    var json = duplexJSON(connection)
    .once('error', function () { disconnect('invalid JSON') })

    // An object recording information about the state of reading from
    // the log.
    //
    // - doneStreaming (boolean): The server is done streaming old
    //   entries.
    //
    // - buffer (array): Contains entries made after the server
    //   started streaming old entries, but before it finished.
    //
    // - stream (stream): The stream of log entries, or null when
    //   doneStreaming is true.
    //
    // - from (Number): The index of the first entry to send.
    var reading = false

    // A read advances, in order, through three phases:
    //
    // Phase 1. Streaming entries from a snapshot of the LevelUP store
    //          created by `.createReadStream`, fetching their content
    //          from the blob store.
    //
    // Phase 2. Sending entries that were buffered while completing
    //          Phase 1.
    //
    // Phase 3. Sending entries as they are written.
    //
    // Comments with "Phase 1", "Phase 2", and "Phase 3" appear in
    // relevant places below.

    // An asynchronous queue for appending to the log. Ensures that each
    // append operation can read the head of the log and number itself
    // appropriately.
    var writeQueue = asyncQueue(function write (message, done) {
      // Compute the hash of the entry's content.
      var content = stringify(message.entry)
      var hash = hashFunction(content)
      // Create a child log for this entry write.
      var writeLog = connectionLog.child({hash: hash})
      // Append the entry payload in the blob store, by hash.
      blobs.createWriteStream({key: hashToPath(hash)})
      .once('error', /* istanbul ignore next */ function (error) {
        writeLog.error(error)
        json.write({id: message.id, error: error.toString()}, done)
      })
      .once('finish', function appendToLog () {
        // Append an entry to the log with the hash of the entry.
        writeLog.info({event: 'appending', hash: hash})
        logs.append(LOG_NAME, hash, function yieldResult (error, index) {
          /* istanbul ignore if */
          if (error) {
            writeLog.error(error)
            json.write({id: message.id, error: error.toString()}, done)
          } else {
            writeLog.info({event: 'wrote'})
            // Send confirmation.
            var confirmation = {id: message.id, index: index}
            json.write(confirmation, done)
            // Emit an event.
            emitter.emit('entry', index, message.entry, connection)
          }
        })
      })
      .end(content)
    })

    // Route client messages to appropriate handlers.
    json.on('data', function routeMessage (message) {
      connectionLog.info({event: 'message', message: message})
      if (readMessage(message)) onReadMessage(message)
      else if (writeMessage(message)) writeQueue.push(message)
      else {
        connectionLog.warn({event: 'invalid', message: message})
        json.write({error: 'invalid message'})
      }
    })

    // Handle read requests.
    function onReadMessage (message) {
      if (reading) {
        connectionLog.warn('already reading')
        json.write({error: 'already reading'})
        return
      }
      reading = {doneStreaming: false, buffer: [], from: message.from}

      // Start buffering new entries appended while sending old entries.
      emitter.addListener('entry', onAppend)

      // Phase 1: Stream index-hash pairs from the LevelUP store.
      var streamLog = connectionLog.child({phase: 'stream'})
      streamLog.info({event: 'create'})
      var streamOptions = {since: message.from - 1}
      var levelReadStream = logs.createReadStream(LOG_NAME, streamOptions)
      reading.stream = levelReadStream
      var transform = through2.obj(function (logEntry, _, done) {
        blobs.createReadStream({key: hashToPath(logEntry.value)})
        .once('error', fail)
        .pipe(concatStream(function (json) {
          done(null, {index: logEntry.seq, entry: JSON.parse(json)})
        }))
      })
      levelReadStream
        .once('error', fail)
        .pipe(transform)
        .once('error', fail)
        .pipe(json, {end: false})
      endOfStream(levelReadStream, function (error) {
        /* istanbul ignore if */
        if (error) disconnect(error.toString())
        else {
          // Mark the stream done so messages sent via the
          // EventEmitter will be written out to the socket, rather
          // than buffered.
          reading.buffer.forEach(function (buffered) {
            streamLog.info({event: 'unbuffer', index: buffered.index})
            json.write(buffered)
          })
          reading.buffer = null
          reading.doneStreaming = true
          // Send up-to-date message.
          json.write({current: true})
        }
      })

      /* istanbul ignore next */
      function fail (error) {
        streamLog.error(error)
        disconnect(error.toString())
        levelReadStream.destroy()
        transform.destroy()
        json.destroy()
      }
    }

    function onAppend (index, entry, fromConnection) {
      // Do not send entries from earlier in the log than requested.
      if (reading.from > index) return
      // Phase 3:
      if (reading.doneStreaming) {
        connectionLog.info({event: 'forward', index: index})
        sendEntry(index, entry)
      // Waiting for Phase 2
      } else {
        connectionLog.info({event: 'buffer', index: index})
        reading.buffer.push({index: index, entry: entry})
      }
    }

    function sendEntry (index, entry, callback) {
      json.write({index: index, entry: entry}, callback || noop)
      connectionLog.info({event: 'sent', index: index})
    }

    function disconnect (error) {
      connectionLog.error({error: error})
      json.write({error: error})
      emitter.removeListener('entry', onAppend)
      if (reading) {
        reading.stream.destroy()
        writeQueue.kill()
      }
      reading = false
      connection.destroy()
    }
  }
}

function noop () { return }

function readMessage (argument) {
  return (
    typeof argument === 'object' &&
    has(argument, 'from', isPositiveInteger)
  )
}

function writeMessage (argument) {
  return (
    typeof argument === 'object' &&
    has(argument, 'id', function (id) { return id.length > 0 }) &&
    has(argument, 'entry', function (entry) {
      return typeof entry === 'object'
    })
  )
}

function has (argument, key, predicate) {
  return (
    argument.hasOwnProperty(key) &&
    typeof predicate === 'function'
      ? predicate(argument[key])
      : argument[key] === predicate
  )
}

function isPositiveInteger (argument) {
  return Number.isInteger(argument) && argument > 0
}

function hashToPath (hash) {
  return hash.slice(0, 2) + '/' + hash.slice(2)
}
