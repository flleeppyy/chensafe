const logger = require('./logger')

// Stray errors and exceptions capturers
process.on('uncaughtException', error => {
  logger.error(error, { prefix: 'Uncaught Exception: ' })
})

process.on('unhandledRejection', error => {
  logger.error(error, { prefix: 'Unhandled Rejection (Promise): ' })
})

// Libraries
const fs = require('fs')
const helmet = require('helmet')
const HyperExpress = require('hyper-express')
const NodeClam = require('clamscan')

// Check required config files
const configFiles = ['config.js', 'views/_globals.njk']
for (const _file of configFiles) {
  try {
    fs.accessSync(_file, fs.constants.R_OK)
  } catch (error) {
    logger.error(`Config file '${_file}' cannot be found or read.`)
    logger.error('Please copy the provided sample file and modify it according to your needs.')
    process.exit(1)
  }
}

// Config files
const config = require('./config')
const versions = require('./src/versions')

// chensafe
logger.log('Starting chensafe\u2026')
const safe = new HyperExpress.Server({
  trust_proxy: Boolean(config.trustProxy)
})

const errors = require('./controllers/errorsController')
const paths = require('./controllers/pathsController')
paths.initSync()
const utils = require('./controllers/utilsController')

// Middlewares
const ExpressCompat = require('./controllers/middlewares/ExpressCompat')
const NunjucksRenderer = require('./controllers/middlewares/NunjucksRenderer')
const RateLimiter = require('./controllers/middlewares/RateLimiter')
const ServeLiveDirectory = require('./controllers/middlewares/ServeLiveDirectory')
const ServeStaticQuick = require('./controllers/middlewares/ServeStaticQuick')

// Handlers
const ServeStatic = require('./controllers/handlers/ServeStatic')

// Routes
const album = require('./routes/album')
const api = require('./routes/api')
const file = require('./routes/file')
const nojs = require('./routes/nojs')
const player = require('./routes/player')

// Express-compat
const expressCompatInstance = new ExpressCompat()
safe.use(expressCompatInstance.middleware)

// Rate limiters
if (Array.isArray(config.rateLimiters)) {
  let whitelistedKeys
  if (Array.isArray(config.rateLimitersWhitelist)) {
    whitelistedKeys = new Set(config.rateLimitersWhitelist)
  }
  for (const rateLimit of config.rateLimiters) {
    // Init RateLimiter using Request.ip as key
    const rateLimiterInstance = new RateLimiter('ip', rateLimit.options, whitelistedKeys)
    for (const route of rateLimit.routes) {
      safe.use(route, rateLimiterInstance.middleware)
    }
  }
} else if (config.rateLimits) {
  logger.error('Config option "rateLimits" is DEPRECATED.')
  logger.error('Please consult the provided sample file for the new option "rateLimiters".')
}

// Helmet security headers
if (config.helmet instanceof Object) {
  // If an empty object, simply do not use Helmet
  if (Object.keys(config.helmet).length) {
    safe.use(helmet(config.helmet))
  }
} else {
  // Fallback to old behavior when the whole helmet option was not configurable from the config file
  const defaults = {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    hsts: false,
    originAgentCluster: false
  }

  if (config.hsts instanceof Object && Object.keys(config.hsts).length) {
    defaults.hsts = config.hsts
  }

  safe.use(helmet(defaults))
}

// Access-Control-Allow-Origin
if (config.accessControlAllowOrigin) {
  if (config.accessControlAllowOrigin === true) {
    config.accessControlAllowOrigin = '*'
  }
  safe.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', config.accessControlAllowOrigin)
    if (config.accessControlAllowOrigin !== '*') {
      res.vary('Origin')
    }
    next()
  })
}

// NunjucksRenderer middleware
const nunjucksRendererInstance = new NunjucksRenderer('views', {
  watch: utils.devmode
})
safe.use(nunjucksRendererInstance.middleware)

// Array of routes to apply CDN Cache-Control onto,
// and additionally call Cloudflare API to have their CDN caches purged when chensafe starts
const cdnRoutes = [...config.pages]

// Defaults to validating cache's validity before using them (soft cache)
let setHeadersForStaticAssets = (req, res) => {
  res.header('Cache-Control', 'no-cache')
}

// Cache control
if (config.cacheControl) {
  const cacheControls = {
    // max-age: 6 months
    static: 'public, max-age=15778800, immutable',
    // s-max-age: 6 months (only cache in CDN)
    cdn: 's-max-age=15778800, proxy-revalidate',
    // validate cache's validity before using them (soft cache)
    validate: 'no-cache',
    // do not use cache at all
    disable: 'no-store'
  }

  // By default soft cache everything
  safe.use((req, res, next) => {
    res.header('Cache-Control', cacheControls.validate)
    return next()
  })

  switch (config.cacheControl) {
    case 1:
    case true:
      // If using CDN, cache most front-end pages in CDN
      // Include /api/check since it will only reply with persistent JSON payload
      // that will not change, unless config file is edited and chensafe is then restarted
      cdnRoutes.push('api/check')
      safe.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const page = req.path === '/' ? 'home' : req.path.substring(1)
          if (cdnRoutes.includes(page)) {
            res.header('Cache-Control', cacheControls.cdn)
          }
        }
        return next()
      })
      break
  }

  // Function for static assets.
  // This requires the assets to use version in their query string,
  // as they will be cached by clients for a very long time.
  setHeadersForStaticAssets = (req, res) => {
    res.header('Cache-Control', cacheControls.static)
  }

  // Consider album ZIPs static as well, since they use version in their query string
  safe.use('/api/album/zip', (req, res, next) => {
    const versionString = parseInt(req.query_parameters.v)
    if (versionString > 0) {
      res.header('Cache-Control', cacheControls.static)
    } else {
      res.header('Cache-Control', cacheControls.disable)
    }
    return next()
  })
}

// Init ServeStaticQuick middlewares for static assets
// Static assets in /dist directory
const serveStaticQuickDistInstance = new ServeStaticQuick(paths.dist, {
  setHeaders: setHeadersForStaticAssets
})
safe.use(serveStaticQuickDistInstance.middleware)
// Static assets in /public directory
const serveStaticQuickPublicInstance = new ServeStaticQuick(paths.public, {
  setHeaders: setHeadersForStaticAssets
})
safe.use(serveStaticQuickPublicInstance.middleware)

// Routes
safe.use(album)
safe.use(file)
safe.use(nojs)
safe.use(player)
safe.use('/api', api)

;(async () => {
  try {
    // Init database
    await require('./controllers/utils/initDatabase')(utils.db)

    // Purge any leftover in chunks directory, do not wait
    paths.purgeChunks()

    if (!Array.isArray(config.pages) || !config.pages.length) {
      logger.error('Config file does not have any frontend pages enabled')
      process.exit(1)
    }

    // Re-map version strings if cache control is enabled (safe.fiery.me)
    utils.versionStrings = {}
    if (config.cacheControl) {
      for (const type in versions) {
        utils.versionStrings[type] = `?_=${versions[type]}`
      }
      if (versions['1']) {
        utils.clientVersion = versions['1']
      }
    }

    const serveLiveDirectoryCustomPagesInstance = new ServeLiveDirectory(paths.customPages, {
      instanceOptions: {
        keep: ['.html']
      }
    })

    // Cookie Policy
    if (config.cookiePolicy) {
      config.pages.push('cookiepolicy')
    }

    // Front-end pages middleware
    // HTML files in customPages directory can also override any built-in pages,
    // if they have matching names with the routes (e.g. home.html can override the homepage)
    // Aside from that, due to using LiveDirectory,
    // custom pages can be added/removed on the fly while chensafe is running
    safe.use((req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const page = req.path === '/' ? 'home' : req.path.substring(1)
        const customPage = serveLiveDirectoryCustomPagesInstance.instance.get(`${page}.html`)
        if (customPage) {
          return serveLiveDirectoryCustomPagesInstance.handler(req, res, customPage)
        } else if (config.pages.includes(page)) {
          // These rendered pages are persistently cached during production
          return res.render(page, {
            config, utils, versions: utils.versionStrings
          }, !utils.devmode)
        }
      }
      return next()
    })

    // Init ServerStatic last if serving uploaded files with node
    if (config.serveFilesWithNode) {
      const serveStaticInstance = new ServeStatic(paths.uploads, {
        contentDispositionOptions: config.contentDispositionOptions,
        ignorePatterns: [
          '/chunks/'
        ],
        overrideContentTypes: config.overrideContentTypes,
        setContentDisposition: config.setContentDisposition
      })

      safe.get('/*', serveStaticInstance.handler)
      safe.head('/*', serveStaticInstance.handler)

      // Keep reference to internal SimpleDataStore in utils,
      // allowing the rest of chensafe to directly interface with it
      utils.contentDispositionStore = serveStaticInstance.contentDispositionStore
    }

    // Web server error handlers (must always be set after all routes/middlewares)
    safe.set_not_found_handler(errors.handleNotFound)
    safe.set_error_handler(errors.handleError)

    // Git hash
    if (config.showGitHash) {
      utils.gitHash = await new Promise((resolve, reject) => {
        require('child_process').exec('git rev-parse HEAD', (error, stdout) => {
          if (error) return reject(error)
          resolve(stdout.replace(/\n$/, ''))
        })
      })
      logger.log(`Git commit: ${utils.gitHash}`)
    }

    // ClamAV scanner
    if (config.uploads.scan && config.uploads.scan.enabled) {
      if (!config.uploads.scan.clamOptions) {
        logger.error('Missing object config.uploads.scan.clamOptions (check config.sample.js)')
        process.exit(1)
      }
      utils.scan.instance = await new NodeClam().init(config.uploads.scan.clamOptions)
      utils.scan.version = await utils.scan.instance.getVersion().then(s => s.trim())
      logger.log(`Connection established with ${utils.scan.version}`)
    }

    // Await all ServeLiveDirectory and ServeStaticQuick instances
    await Promise.all([
      serveStaticQuickDistInstance.ready(),
      serveStaticQuickPublicInstance.ready(),
      serveLiveDirectoryCustomPagesInstance.ready()
    ])

    // Binds Express to port
    await safe.listen(utils.conf.port)
    logger.log(`chensafe started on port ${utils.conf.port}`)

    // Cache control (safe.fleepy.tv)
    // Purge Cloudflare cache
    if (config.cacheControl && config.cacheControl !== 2) {
      if (config.cloudflare.purgeCache) {
        logger.log('Cache control enabled, purging Cloudflare\'s cache...')
        const results = await utils.purgeCloudflareCache(cdnRoutes)
        let errored = false
        let succeeded = 0
        for (const result of results) {
          if (result.errors.length) {
            if (!errored) errored = true
            result.errors.forEach(error => logger.log(`[CF]: ${error}`))
            continue
          }
          succeeded += result.files.length
        }
        if (!errored) {
          logger.log(`Successfully purged ${succeeded} cache`)
        }
      } else {
        logger.log('Cache control enabled without Cloudflare\'s cache purging')
      }
    }

    // Initiate internal periodical check ups of temporary uploads if required
    if (utils.retentions && utils.retentions.enabled && config.uploads.temporaryUploadsInterval > 0) {
      let temporaryUploadsInProgress = false
      const temporaryUploadCheck = async () => {
        if (temporaryUploadsInProgress) return

        temporaryUploadsInProgress = true
        try {
          const result = await utils.bulkDeleteExpired(false, utils.devmode)

          if (result.expired.length || result.failed.length) {
            if (utils.devmode) {
              let logMessage = `Expired uploads (${result.expired.length}): ${result.expired.map(_file => _file.name).join(', ')}`
              if (result.failed.length) {
                logMessage += `\nErrored (${result.failed.length}): ${result.failed.map(_file => _file.name).join(', ')}`
              }
              logger.debug(logMessage)
            } else {
              let logMessage = `Expired uploads: ${result.expired.length} deleted`
              if (result.failed.length) {
                logMessage += `, ${result.failed.length} errored`
              }
              logger.log(logMessage)
            }
          }
        } catch (error) {
          // Simply print-out errors, then continue
          logger.error(error)
        }

        temporaryUploadsInProgress = false
      }

      temporaryUploadCheck()
      setInterval(temporaryUploadCheck, config.uploads.temporaryUploadsInterval)
    }

    // NODE_ENV=development yarn start
    if (utils.devmode) {
      const { inspect } = require('util')
      // Add readline interface to allow evaluating arbitrary JavaScript from console
      require('readline').createInterface({
        input: process.stdin
      }).on('line', line => {
        try {
          if (line === 'rs') return
          if (line === '.exit') return process.exit(0)
          // eslint-disable-next-line no-eval
          const evaled = eval(line)
          process.stdout.write(`${typeof evaled === 'string' ? evaled : inspect(evaled)}\n`)
        } catch (error) {
          process.stderr.write(`${error.stack}\n`)
        }
      }).on('SIGINT', () => {
        process.exit(0)
      })
      logger.log(utils.stripIndents(`!!! DEVELOPMENT MODE !!!
        [=] Nunjucks will auto rebuild (not live reload)
        [=] HTTP rate limits disabled
        [=] Readline interface enabled (eval arbitrary JS input)`))
    }
  } catch (error) {
    logger.error(error)
    process.exit(1)
  }
})()
