const stream = require('stream')
const hypertrie = require('hypertrie')
const hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const multikey = require('hypercore-multi-key')
const raf = require('random-access-file')
const thunky = require('thunky')
const { EventEmitter } = require('events')
const Protocol = require('hypercore-protocol')

exports = module.exports = storage => new Market(storage)

exports.isSeller = function (s) {
  return s instanceof Seller
}

exports.isBuyer = function (b) {
  return b instanceof Buyer
}

class Market extends EventEmitter {
  constructor (storage) {
    super()

    this._storage = typeof storage === 'function' ? storage : defaultStorage
    this._db = hypertrie(name => this._storage('db/' + name), { valueEncoding: 'json' })
    this._keyPair = null

    const self = this

    this.ready = thunky(this._ready.bind(this))
    this.ready(function (err) {
      if (err) self.emit('error', err)
      else self.emit('ready')
    })

    function defaultStorage (name) {
      const lock = name === 'db/bitfield' ? requireMaybe('fd-lock') : null
      return raf(name, { directory: storage, lock })
    }
  }

  get buyer () {
    return this._keyPair && this._keyPair.publicKey
  }

  _ready (cb) {
    const self = this

    loadKey(this._db, 'buys/key-pair', function (err, kp) {
      if (err) return cb(err)
      self._keyPair = kp
      cb(null)
    })
  }

  buying (cb) {
    this._db.list('buys/feeds', { recursive: false }, function (err, nodes) {
      if (err) return cb(err)
      const list = nodes.map(function (node) {
        const key = Buffer.from(node.key.split('/')[2], 'hex')
        const feed = Buffer.from(node.value.uniqueFeed, 'hex')
        return { key, feed }
      })
      cb(null, list)
    })
  }

  selling (cb) {
    const self = this
    this._db.list('sales', { recursive: false }, function (err, nodes) {
      if (err) return cb(err)

      const list = []
      const feeds = nodes.map(function (node) {
        return Buffer.from(node.key.split('/')[1], 'hex')
      })

      loop(null, null)

      function loop (err, node) {
        if (err) return cb(err)
        if (node) list.push({ key: decodeKeys(node.value).publicKey, feed: feeds[list.length] })
        if (list.length === feeds.length) return cb(null, list)
        const feed = feeds[list.length]
        self._db.get('sales/' + feed.toString('hex') + '/key-pair', loop)
      }
    })
  }

  sell (feed, opts) {
    return new Seller(this, this._db, feed, opts)
  }

  buy (seller, opts) {
    return new Buyer(this, this._db, seller, opts)
  }
}

class Buyer extends EventEmitter {
  constructor (market, db, seller, opts) {
    if (!opts) opts = {}
    super()

    this.seller = seller
    this.feed = null
    this.sparse = !!opts.sparse
    this.info = null

    this._db = db
    this._market = market

    const self = this

    this._db.get('buys/feeds/' + this.seller.toString('hex'), function (err, node) {
      if (err || !node) return
      self._setFeed(Buffer.from(node.value.uniqueFeed, 'hex'))
    })

    this.ready(function (err) {
      if (err) self.emit('error', err)
      else self.emit('ready')
    })
  }

  get key () {
    return this._market.buyer
  }

  get discoveryKey () {
    return hypercore.discoveryKey(this.seller)
  }

  ready (cb) {
    this._market.ready(cb)
  }

  replicate (initiator) {
    if (typeof initiator !== 'boolean') initiator = true

    const self = this

    const p = new Protocol(initiator, {
      keyPair (done) {
        self._market.ready(function (err) {
          if (err) return done(err)
          done(null, self._market.keyPair)
        })
      },
      onauthenticate (remotePublicKey, done) {
        if (remotePublicKey.equals(self.seller)) return done(null)
        const error = new Error('Not connected to seller')
        self.emit('invalid', error)
        done(error)
      }
    })

    p.registerExtension('dazaar/one-time-feed', {
      onmessage (uniqueFeed) {
        const feed = self._setFeed(uniqueFeed)
        self.emit('validate', uniqueFeed)
        feed.replicate(p, { live: true })
      }
    })

    p.registerExtension('dazaar/valid', {
      encoding: 'json',
      onmessage (info) {
        self.info = info
        self.emit('valid', info)
      }
    })

    p.registerExtension('dazaar/invalid', {
      encoding: 'json',
      onmessage (info) {
        self.emit('invalid', new Error(info.error))
      }
    })

    return p
  }

  _setFeed (key) {
    const self = this
    if (this.feed) return this.feed
    const uniqueFeed = hypercore(name => this._market._storage('buys/' + key.toString('hex') + '/' + name), key, {
      sparse: this.sparse
    })
    this.feed = uniqueFeed
    const k = 'buys/feeds/' + this.seller.toString('hex')
    this._db.get(k, function (err, node) {
      if (err || node) return
      self._db.put(k, { seller: self.seller.toString('hex'), uniqueFeed: key.toString('hex') })
    })
    this.feed.ready(() => this.emit('feed', this.feed))
    return uniqueFeed
  }
}

class Seller extends EventEmitter {
  constructor (market, db, feed, opts) {
    if (typeof opts === 'function') opts = { validate: opts }
    super()

    this.feed = feed
    this.validate = opts.validate
    this.revalidate = opts.validateInterval || 1000
    this.info = null

    this._db = db
    this._market = market
    this._keyPair = null

    const self = this

    this.ready = thunky(this._ready.bind(this))
    this.ready(function (err) {
      if (err) self.emit('error', err)
      else self.emit('ready')
    })
  }

  get key () {
    return this._keyPair && this._keyPair.publicKey
  }

  get discoveryKey () {
    return this.key && hypercore.discoveryKey(this.key)
  }

  _ready (cb) {
    const self = this
    this.feed.ready(function (err) {
      if (err) return cb(err)
      const key = 'sales/' + self.feed.key.toString('hex') + '/key-pair'
      loadKey(self._db, key, function (err, kp) {
        if (err) return cb(err)
        self._keyPair = kp
        cb(null)
      })
    })
  }

  buyers (cb) {
    const self = this
    const list = []

    this.feed.ready(function (err) {
      if (err) return cb(err)

      const ite = self._db.iterator('sales/' + self.feed.key.toString('hex') + '/feeds')

      ite.next(function loop (err, node) {
        if (err) return cb(err)
        if (!node) return cb(null, list)

        list.push({
          buyer: Buffer.from(node.value.buyer, 'hex'),
          uniqueFeed: decodeKeys(node.value.uniqueFeed)
        })

        ite.next(loop)
      })
    })
  }

  replicate (initiator) {
    if (typeof initiator !== 'boolean') initiator = false

    const self = this

    let uniqueFeed
    let timeout
    let isValid

    const p = new Protocol(initiator, {
      keyPair (done) {
        self.ready(function (err) {
          if (err) return done(err)
          done(null, self._keyPair)
        })
      },
      onauthenticate (remotePublicKey, done) {
        done()
      },
      onhandshake () {
        validate()

        function setUploading (error, info) {
          const uploading = !error
          if (uniqueFeed) {
            uniqueFeed.setUploading(uploading)
          }

          if (error) {
            if (isValid !== false) {
              isValid = false
              invalid.send({ error: error.message })
              self.emit('invalid', p.remotePublicKey, error)
            }
          } else {
            if (isValid !== true) {
              isValid = true
            }
            if (info && typeof info === 'object') {
              self.info = info
              self.emit('valid', p.remotePublicKey, info)
              valid.send(info)
            } else {
              self.emit('valid', p.remotePublicKey, null)
            }
          }

          timeout = setTimeout(validate, self.revalidate)
        }

        function onvalidate (err, info) {
          if (err) return setUploading(err, null)
          getUniqueFeed(function (err, feed) {
            if (err) return stream.destroy(err)
            if (!uniqueFeed) {
              uniqueFeed = feed
              oneTimeFeed.send(feed.key)
              uniqueFeed.replicate(p, { live: true })
            }
            setUploading(null, info)
          })
        }

        function validate () {
          if (p.destroyed) return
          self.emit('validate', p.remotePublicKey)
          self.validate(p.remotePublicKey, function (err, info) {
            if (p.destroyed) return
            onvalidate(err, info)
          })
        }
      }
    })

    const oneTimeFeed = p.registerExtension('dazaar/one-time-feed')
    const valid = p.registerExtension('dazaar/valid', { encoding: 'json' })
    const invalid = p.registerExtension('dazaar/invalid', { encoding: 'json' })

    p.on('close', function () {
      clearTimeout(timeout)
      if (uniqueFeed) uniqueFeed.close()
    })

    return p

    function getUniqueFeed (cb) {
      if (uniqueFeed) return cb(null, uniqueFeed)
      getUniqueKeyPair(function (err, keyPair) {
        if (err) return cb(err)
        if (p.destroyed) return cb(new Error('Stream destroyed'))
        const feed = multikey(self.feed, decodeKeys(keyPair))
        feed.ready(function (err) {
          if (err) return cb(err)
          if (p.destroyed) {
            feed.close()
            return cb(new Error('Stream destroyed'))
          }
          cb(null, feed)
        })
      })
    }

    function getUniqueKeyPair (cb) {
      const key = 'sales/' + self.feed.key.toString('hex') + '/feeds/' + p.remotePublicKey.toString('hex')

      self._db.get(key, function (err, node) {
        if (err) return cb(err)

        if (!node) {
          const keyPair = crypto.keyPair()
          self._db.put(key, { buyer: p.remotePublicKey.toString('hex'), uniqueFeed: encodeKeys(keyPair) }, function (err) {
            if (err) return cb(err)
            cb(null, keyPair)
          })
          return
        }

        cb(null, decodeKeys(node.value.uniqueFeed))
      })
    }
  }
}

function decodeKeys (keys) {
  return {
    publicKey: Buffer.from(keys.publicKey, 'hex'),
    secretKey: Buffer.from(keys.secretKey, 'hex')
  }
}

function encodeKeys (keys) {
  return {
    publicKey: keys.publicKey.toString('hex'),
    secretKey: keys.secretKey.toString('hex')
  }
}

function loadKey (db, key, cb) {
  db.get(key, function (err, node) {
    if (err) return cb(err)
    if (node) return cb(null, decodeKeys(node.value))
    const keyPair = Protocol.keyPair()
    db.put(key, encodeKeys(keyPair), function (err) {
      if (err) return cb(err)
      cb(null, keyPair)
    })
  })
}

function requireMaybe (name) {
  try {
    return require(name)
  } catch (_) {
    return null
  }
}
