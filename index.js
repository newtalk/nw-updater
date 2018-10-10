var request = require('request');
var path = require('path');
var os = require('os');
var fs = require('fs');
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var semver = require('semver');

var platform = process.platform;
var platform_bit = process.arch == 'ia32' ? '32' : '64';
var logger;

platform = /^win/.test(platform) ? 'win' + platform_bit : /^darwin/.test(platform) ? 'mac' : 'linux' + platform_bit;

if ( semver.lte('0.14.7',process.versions.nw) )
    platform='winxp';

/**
 * Creates new instance of updater. Manifest could be a `package.json` of project.
 *
 * Note that compressed app are assumed to be downloaded in the format produced by [node-webkit-builder](https://github.com/mllrsohn/node-webkit-builder) (or [grunt-node-webkit-builder](https://github.com/mllrsohn/grunt-node-webkit-builder)).
 *
 * @constructor
 * @param {object} manifest - See the [manifest schema](#manifest-schema) below.
 * @param {object} options - Optional
 * @property {string} options.temporaryDirectory - (Optional) path to a directory to download the updates to and unpack them in. Defaults to [`os.tmpdir()`](https://nodejs.org/api/os.html#os_os_tmpdir)
 */
function updater(manifest, options, log) {
    logger = log || function () { };
    this.manifest = manifest;
    this.options = {
        temporaryDirectory: options && options.temporaryDirectory || os.tmpdir()
    };
}


/**
 * Will check the latest available version of the application by requesting the manifest specified in `manifestUrl`.
 *
 * The callback will always be called; the second parameter indicates whether or not there's a newer version.
 * This function assumes you use [Semantic Versioning](http://semver.org) and enforces it; if your local version is `0.2.0` and the remote one is `0.1.23456` then the callback will be called with `false` as the second paramter. If on the off chance you don't use semantic versioning, you could manually download the remote manifest and call `download` if you're happy that the remote version is newer.
 *
 * @param {function} cb - Callback arguments: error, newerVersionExists (`Boolean`), remoteManifest
 */
updater.prototype.checkNewVersion = function (cb) {
    request.get(this.manifest.manifestUrl, gotManifest.bind(this)); //get manifest from url

    /**
     * @private
     */
    function gotManifest(err, req, data) {
        if (err) {
            return cb(err);
        }

        if (req.statusCode < 200 || req.statusCode > 299) {
            return cb(new Error(req.statusCode));
        }

        try {
            data = JSON.parse(data);
        } catch (e) {
            return cb(e)
        }
        cb(null, semver.gt(data.version, this.manifest.version) && data.packages[platform], data);
    }
};

/**
 * Downloads the new app to a template folder
 * @param  {Function} cb - called when download completes. Callback arguments: error, downloaded filepath
 * @param  {Object} newManifest - see [manifest schema](#manifest-schema) below
 * @return {Request} Request - stream, the stream contains `manifest` property with new manifest and 'content-length' property with the size of package.
 */
updater.prototype.download = function (cb, newManifest) {

    var manifest = newManifest || this.manifest;
    var url = manifest.packages[platform].url;
    logger.log("download zip file in " + url);
    var thread = request(url, function (err, response) {
        if (err) {
            cb(err);
        }
        if (response && (response.statusCode < 200 || response.statusCode >= 300)) {
            thread.abort();
            return cb(new Error(response.statusCode));
        }
    });
    thread.on('response', function (response) {
        if (response && response.headers && response.headers['content-length']) {
            thread['content-length'] = response.headers['content-length'];
        }
    });
    var filename = path.basename(url),
        destinationPath = path.join(this.options.temporaryDirectory, filename);
    // download the package to template folder
    fs.unlink(path.join(this.options.temporaryDirectory, filename), function () {
        thread.pipe(fs.createWriteStream(destinationPath));
        thread.resume();
    });
    thread.on('error', cb);
    thread.on('end', appDownloaded );
    thread.pause();

    function appDownloaded() {
        process.nextTick(function () {
            if (thread.response.statusCode >= 200 && thread.response.statusCode < 300) {
                fs.rename(destinationPath, destinationPath, function(err) {
                    if (err) 
                        cb(err);
                    else
                        cb(null, destinationPath);
                });
            }
        });
    }
    return thread;
};


/**
 * Returns executed application path
 * @returns {string}
 */
updater.prototype.getAppPath = function () {
    var appPath = {
        mac: path.join(process.cwd(), '../../..'),
        win32: path.dirname(process.execPath)
    };
    appPath.win64 = appPath.win32;
    appPath.linux32 = appPath.win32;
    appPath.linux64 = appPath.win32;
    return appPath[platform];
};


/**
 * Returns current application executable
 * @returns {string}
 */
updater.prototype.getAppExec = function () {
    var execFolder = this.getAppPath();
    var exec = {
        mac: '',
        win32: path.basename(process.execPath),
        win64: path.basename(process.execPath),
        linux32: path.basename(process.execPath),
        linux64: path.basename(process.execPath)
    };
    return path.join(execFolder, exec[platform]);
};

/**
 * Runs installer
 * @param {string} appPath
 * @param {array} args - Arguments which will be passed when running the new app
 * @param {object} options - Optional
 * @returns {function}
 */
updater.prototype.runInstaller = function (appPath, args, options) {
    return pRun[platform].apply(this, arguments);
};

var pRun = {
    /**
     * @private
     */
    mac: function (appPath, args, options) {
        //spawn
        if (args && args.length) {
            args = [appPath].concat('--args', args);
        } else {
            args = [appPath];
        }
        return run('open', args, options);
    },
    /**
     * @private
     */
    win32: function (appPath, args, options, cb) {
        logger.log("Windows new app path is " + appPath);
        return run(appPath, args, options, cb);
    },
    /**
     * @private
     */
    linux32: function (appPath, args, options, cb) {
        var appExec = path.join(appPath, path.basename(this.getAppExec()));
        fs.chmodSync(appExec, 0755);
        if (!options) options = {};
        options.cwd = appPath;
        return run(appPath + "/" + path.basename(this.getAppExec()), args, options, cb);
    }
};

pRun.win64 = pRun.win32;
pRun.winxp = pRun.win32;
pRun.linux64 = pRun.linux32;

/**
 * @private
 */
function run(path, args, options) {
    try{
        var opts = {
            detached: true
            // stdio: 'ignore'
        };
        for (var key in options) {
            logger.log("options key is " + opts[key]);
            opts[key] = options[key];
        }

        var sp = spawn(path, args, opts);

        sp.unref();
        return sp;

    }catch(error){
        logger.log(error);
        return null;
    }
}

/**
 * Runs the app from original app executable path.
 * @param {string} execPath
 * @param {array} args - Arguments passed to the app being ran.
 * @param {object} options - Optional. See `spawn` from nodejs docs.
 *
 * Note: if this doesn't work, try `gui.Shell.openItem(execPath)` (see [node-webkit Shell](https://github.com/rogerwang/node-webkit/wiki/Shell)).
 */
updater.prototype.run = function (execPath, args, options) {
    var arg = arguments;
    if (platform.indexOf('linux') === 0) arg[0] = path.dirname(arg[0]);
    pRun[platform].apply(this, arg);
};

module.exports = updater;
