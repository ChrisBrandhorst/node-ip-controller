'use strict'

const EventEmitter  = require('events'),
      net           = require('net'),
      debounce      = require('debounce'),
      merge         = require('merge'),
      NetKeepAlive  = require('net-keepalive'),
      Processor     = require('./processor'),

      DEBOUNCE_INTERVAL   = 100,
      CONNECT_TIMEOUT     = 3 * 1000,
      RECONNECT_INTERVAL  = 3 * 1000,
      KEEP_ALIVE_TIMEOUT  = 15 * 60 * 1000,

      Status = {
        DISCONNECTED: 0,
        CONNECTING:   1,
        CONNECTED:    2
      },

      startStatus   = {
        connected:  false,
        connecting: false
      }


module.exports = class IPController extends EventEmitter {

  /**
   *
   */
  constructor(defaultOptions, options, status, processors) {
    super()
    var self = this

    options = merge({}, defaultOptions, options)
    // TODO: error handling for missing / invalid options

    this.host = options.host
    this.port = options.port
    this.terminator = options.terminator || "\r"
    this.connectTimeout = options.connectTimeout >= 0 ? options.connectTimeout : CONNECT_TIMEOUT
    this.reconnectInterval = options.reconnectInterval >= 0 ? options.reconnectInterval : RECONNECT_INTERVAL
    this.keepAliveTimeout = options.keepAliveTimeout >= 0 ? options.keepAliveTimeout : KEEP_ALIVE_TIMEOUT

    this.processors = {}
    processors(function(){
      self.setProcessor.apply(self, arguments)
    })

    this.status = merge({}, startStatus, status)

    this.emitStatusUpdate = debounce(this.emitStatusUpdate, DEBOUNCE_INTERVAL)
  }


  /**
   *
   */
  connect() {
    var self = this

    function tryConnect(resolve, reject) {

      var connTimeout,
          connDesc = self.host + ":" + self.port

      console.info(`Connecting to ${connDesc}...`)
      self.set('connecting', true)

      var socket = net

        // Connect
        .connect(self.port, self.host, () => {
          console.info(`Connection to ${connDesc} established`)
          clearTimeout(connTimeout)
          socket.removeAllListeners('error')
          self.set('connecting', false)
          self.set('connected', true)
          self.afterConnected(socket)
          resolve(self)
        })

        // Error, close is called immediately after this
        .on('error', (error) => {
          console.error(`Error connecting to ${connDesc}: ${error}`)
        })

        // Close
        .on('close', (had_error) => {
          console.warn(`Connection to ${connDesc} closed` + (had_error ? " because of an error" : "") )
          clearTimeout(connTimeout)
          socket.removeAllListeners()
          socket.destroy()
          self.set('connected', false)

          // Reconnect (or not)
          if (self.reconnectInterval > 0) {
            console.info(`Waiting ${self.reconnectInterval} ms for reconnecting to ${connDesc}...`)
            setTimeout(function(){
              tryConnect(resolve, reject)
            }, self.reconnectInterval)
          }
          else {
            self.set('connecting', false)
            reject(self)
          }

        })

      // Destroy socket if connecting takes too long
      connTimeout = setTimeout(function(){
        console.warn(`Timeout on connection attempt to ${connDesc}`)
        socket.destroy()
      }, self.connectTimeout)

    }

    // Return promise object
    return new Promise( (resolve, reject) => {
      if (!self.status.connected && !self.status.connecting) {
        tryConnect(resolve, reject)
      }
      else {
        self.emit('error', "Cannot connect: already connect" + ( self.status == Status.CONNECTING ? "ing" : "ed" ) )
        reject(self)
      }
      return self
    })

  }


  /**
   *
   */
  afterConnected(socket) {
    var self      = this,
        connDesc  = self.host + ":" + self.port

    self.socket = socket
    self.emit('connect', self)

    // Set an actually usefull timeout
    if (self.keepAliveTimeout > 0) {
      socket.setKeepAlive(true, 1000)
      NetKeepAlive.setKeepAliveInterval(socket, 1000)
      NetKeepAlive.setKeepAliveProbes(socket, Math.max( 1, Math.round( self.keepAliveTimeout / 1000 ) ) )
    }

    // If we get a timeout, end the socket
    socket.on('timeout', () => {
      socket.end()
      var desc = `Timeout on connection to ${connDesc}`
      console.error(desc)
      self.emit('timeout', desc, self)
    })

    // If we have an error, destroy the socket (this is followed by a close)
    socket.on('error', (error) => {
      socket.destroy()
      var desc = `Error on connection to ${connDesc}: ${error}`
      console.error(desc)
      self.emit('error', desc, self)
    })

    // If the socket is closed, also emit a close event from the controller
    socket.on('close', (had_error) => {
      self.emit('close', had_error, self)
    })

    // We get data, w00t
    socket.on('data', (data) => {
      read(self, data)
      self.emit('data', data, self)
    })

  }


  /**
   *
   */
  disconnect() {
    this.ensureConnected()
    this.socket.destroy()
  }


  /**
   * Request a property from the receiver. Supports promises and callback
   * methods for processing of the return value, which is delivered async.
   */
  request(prop, callback) {
    var cmd = this.getRequestCommand(prop)
    return writeAndWait(this, prop, cmd, true, callback)
  }


  /**
   *
   */
  getRequestCommand(prop, val, callback) {
    throw new Error('error', "getRequestCommand not implemented")
  }


  /**
   * 
   */
  act(prop, val, callback) {
    var cmd = this.getActCommand(prop, val)
    if (typeof val == 'function')
      callback = val
    return writeAndWait(this, prop, cmd, false, callback)
  }


  /**
   *
   */
  getActCommand(prop, val, callback) {
    throw new Error('error', "getActCommand not implemented")
  }


  /**
   * Send a raw command to the socket
   */
  raw(command) {
    write(this, command)
  }


  /**
   * Emit the current status. This method is debounced.
   */
  emitStatusUpdate() {
    this.emit('update', this.status)
  }


  /**
   * Used to ensure there is an active connection with the receiver before sending.
   */
  ensureConnected() {
    if (!this.status.connected) throw new Error('error', "Unable to execute method: no connection")
  }


  /**
   * Sets a property on the controller status and emits event handlers for the update.
   * Should never be called directly.
   */
  set(prop, val) {
    if (this.status[prop] !== val) {
      this.status[prop] = val
      this.emit('update.' + prop, val)
      this.emitStatusUpdate()
    }
    return val
  }


  /**
   *
   */
  setProcessor(prop, resp, proc) {
    this.processors[prop] = new Processor(prop, resp, proc)
  }


  /**
   *
   */
  processResponse(resp) {
    return resp
  }

}


/**
 * Write a command to the socket.
 */
function write(controller, command) {
  controller.ensureConnected()
  controller.emit('write', command)
  controller.socket.write(command + controller.terminator)
}


/**
 * Writes a command to the socket and registers the given callback or promise handler
 * with the response handler in order for the corresponding response to be returned.
 */
function writeAndWait(controller, prop, command, expectResponse, callback) {
  var promise = new Promise( (resolve) => {
    write(controller, command)
    if (expectResponse) {
      var processor = controller.processors[prop]
      if (!processor) throw new Error("Processor for '" + prop + "' not found")
      processor.addResolver( (result) => {
        if (typeof callback == 'function')
          callback(result)
        resolve(result)
      })
    }
  })
  promise.catch( (err) => {
    console.log(err)
  } )
  return promise
}


/**
 * Processes responses from the socket. The response is fed through all available 
 * processors until the response matches the regex for that processor. The processor
 * is then called and any callbacks / promise handlers are invoked.
 */
function read(controller, resp) {
  resp = controller.processResponse(resp.toString())

  // If we have multiple lines
  if (resp.constructor === Array) {
    for (var i = 0; i < resp.length; i++)
      read(controller, resp[i])
    return
  }

  controller.emit('read', resp)
  
  for (var prop in controller.processors) {
    var processor = controller.processors[prop],
        matchData = resp.match( processor.resp )
    if (matchData) {
      var result = processor.proc(controller, prop, matchData, resp)
      processor.resolve(result)
      break
    }
  }
}







