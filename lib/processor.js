'use strict'

const processors  = {}

/**
 * Class used for processing responses from the receiver.
 * A Processor is created based on a property key, a regex which should match the
 * response coming over the socket and a proc function which states what should be
 * done with the response.
 * Besides that, resolvers can be added to the Processor object which are called when
 * the corresponding response is received.
 */
module.exports = class Processor {

  // 
  constructor(prop, resp, proc) {
    this.prop = prop
    this.resp = resp
    this.proc = proc
    this.clearResolvers()
  }

  // 
  addResolver(resolver) {
    this.resolvers.push(resolver)
  }

  // 
  removeResolver(resolver) {
    var i = array.indexOf(resolver)
    if (i > -1)
      this.resolvers = this.resolvers.splice(index, 1)
    else
      throw new Error("Cannot remove resolver: not present")
  }

  // 
  clearResolvers() {
    this.resolvers = []
  }

  // 
  resolve(result) {
    for( var i in this.resolvers )
      this.resolvers[i](result)
    this.clearResolvers()
  }

}