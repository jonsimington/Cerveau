// Check for npm install first, as many devs forget this pre step
var fs = require("fs");
try {
    if(!fs.lstatSync("./node_modules/").isDirectory()) {
        throw {};
    }
}
catch(e) {
    /* eslint-disable no-console */
    console.error("ERROR: \"node_modules/\" not found.\nDid you forget to run 'npm install'?");
    /* eslint-enable no-console */
    process.exit(1);
}

process.title = "Cerveau Game Server";
global.__basedir = __dirname + "/"; // hackish way to store the base directory we are in now so we don't need require("../../../../whatever") and instead require(__base + "root/path/to/whatever")

require("cadre-js-extensions"); // extends built in JavaScript objects. Extend with care, prototypes can get funky if you are not careful

var args = require("./args");
var extend = require("extend");

var Lobby = require("./gameplay/lobby");
var lobby = new Lobby(args); // the game server for clients to connect to
var log = require("./gameplay/log");

var app = require("./website/app");
if(args.api || args.web) {
    var http = require("http").Server(app);
    var server = http.listen(args.httpPort, function() {
        log("--- HTTP server running on port " + args.httpPort + " ---");
    });

    server.on("error", function(err) {
        log.error(err.code !== "EADDRINUSE" ? err : "Webinterface cannot listen on port " + args.httpPort + ". Address in use.");
    });
}

require("./website/")(extend({
    lobby: lobby,
}, args));

// --- Graceful shutdown: drain running games before exiting ---
// Cerveau game state lives in-memory in worker threads. If we kill the
// process while games are running, those games are lost and clients cannot
// reconnect. So we drain: stop accepting new connections, wait for running
// games to finish, then exit.
var DRAIN_TIMEOUT = 5 * 60 * 1000; // 5 minutes max to drain
var _drainTimer = null;

function gracefulShutdown(reason) {
    if(lobby._isShuttingDown) {
        return; // already draining
    }

    lobby._isShuttingDown = true;
    log("Graceful shutdown triggered: " + reason);

    // Stop accepting new game connections (TCP + WS listeners)
    for(var key in lobby._listenerServer) {
        if(lobby._listenerServer.hasOwnProperty(key)) {
            try { lobby._listenerServer[key].close(); } catch(e) { /* already closed */ }
        }
    }

    // Stop accepting new HTTP connections
    if(typeof server !== "undefined" && server) {
        try { server.close(); } catch(e) { /* already closed */ }
    }

    // Disconnect lobby-waiting clients (not yet in a game)
    var waitingClients = lobby.clients.slice();
    for(var i = 0; i < waitingClients.length; i++) {
        waitingClients[i].disconnect("Server is restarting. Please reconnect shortly.");
    }

    var numRunning = Object.keys(lobby._runningSessions).length;
    log(numRunning + " game(s) currently running.");

    if(numRunning === 0) {
        log("No games to drain, exiting now.");
        process.exit(1);
    }

    log("Waiting up to " + (DRAIN_TIMEOUT / 1000) + "s for running games to finish...");

    // Force exit after drain timeout — games that can't finish in time are lost
    _drainTimer = setTimeout(function() {
        log.error("Drain timeout reached with games still running. Force exiting.");
        process.exit(1);
    }, DRAIN_TIMEOUT);

    // The lobby's existing _sessionOver() already calls process.exit(0)
    // when _isShuttingDown && runningSessions reaches 0.
}

// --- Global error handlers to prevent zombie processes ---
// Without these, an unhandled error can kill listeners but leave the
// Node.js process alive (container stays up, but nothing works => 502).

process.on("uncaughtException", function(err) {
    log.error("Uncaught exception in main process:");
    log.error(err);
    gracefulShutdown("uncaught exception");
});

process.on("unhandledRejection", function(reason) {
    log.error("Unhandled rejection in main process:");
    log.error(reason instanceof Error ? reason : new Error(String(reason)));
    gracefulShutdown("unhandled rejection");
});

// --- Self-watchdog: periodically verify the HTTP server is responsive ---
// If the server becomes unresponsive (e.g. event loop stuck, GC thrashing
// from --max-old-space-size, or listeners died silently), trigger graceful
// shutdown so running games can finish, then the process exits and Docker's
// restart policy brings us back.
var httpModule = require("http");

var WATCHDOG_INTERVAL = 30 * 1000;  // check every 30s
var WATCHDOG_TIMEOUT = 10 * 1000;   // 10s to respond
var watchdogFailures = 0;
var WATCHDOG_MAX_FAILURES = 3;

setInterval(function() {
    if(lobby._isShuttingDown) {
        return; // already draining, don't pile on
    }

    var req = httpModule.get("http://127.0.0.1:" + args.httpPort + "/health", function(res) {
        watchdogFailures = 0; // reset on success
        res.resume(); // consume response data to free memory
    });

    req.on("error", function() {
        watchdogFailures++;
        log.error("Watchdog: health check failed (" + watchdogFailures + "/" + WATCHDOG_MAX_FAILURES + ")");
        if(watchdogFailures >= WATCHDOG_MAX_FAILURES) {
            gracefulShutdown("server unresponsive after " + WATCHDOG_MAX_FAILURES + " consecutive health check failures");
        }
    });

    req.setTimeout(WATCHDOG_TIMEOUT, function() {
        req.destroy();
        watchdogFailures++;
        log.error("Watchdog: health check timed out (" + watchdogFailures + "/" + WATCHDOG_MAX_FAILURES + ")");
        if(watchdogFailures >= WATCHDOG_MAX_FAILURES) {
            gracefulShutdown("server unresponsive after " + WATCHDOG_MAX_FAILURES + " consecutive health check timeouts");
        }
    });
}, WATCHDOG_INTERVAL);
