var express = require("express");
var expressHbs = require("express-handlebars");
var moment = require("moment");

var app = express();

// setup handlebars as the views
app.engine("hbs", expressHbs({
    extname:"hbs",
    defaultLayout:"main.hbs",
    partialsDir: __basedir + "/website/views/partials",
    layoutsDir: __basedir + "/website/views/layouts",
    helpers: {
        formatDate: function(date, format) {
            return moment(date).format(format);
        },
    },
}));
app.set("view engine", "hbs");
app.set("views", __basedir + "/website/views");

// Health check endpoint - returns 200 if the server is responsive
app.get("/health", function(req, res) {
    res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// GET /static/style.css etc.
app.use("/styles", express.static(__basedir + "/website/styles"));
app.use("/gamelogs", express.static(__basedir + "/output/gamelogs"));

// Global Express error handler — catches errors from serve-static/send/fresh
// that would otherwise become uncaughtExceptions and crash the process.
// Must have 4 args (err, req, res, next) for Express to recognize it as error middleware.
app.use(function(err, req, res, next) { // eslint-disable-line no-unused-vars
    /* eslint-disable no-console */
    console.error("Express error on " + req.method + " " + req.url + ":", err.message);
    /* eslint-enable no-console */
    if(!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = app;
