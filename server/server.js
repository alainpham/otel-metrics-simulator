const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const axios = require('axios');
const logger = require('./logger');
const liveReload = require('./livereload');
const simulator = require('./simulator');

// add the prometheus middleware to all routes
const app = express();
const PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, "../public");

// Middleware
app.use(bodyParser.json());

liveReload.attach(app, PUBLIC_DIR); // dev only, no-op unless LIVERELOAD=1
app.use(express.static(PUBLIC_DIR)); // Serve static files


app.get("/ping", (req, res) => {
    logger.info("Received ping");
    res.status(200).json({ message: "pong" });
});

// Simulator API
app.get("/api/config", (req, res) => {
    res.json(simulator.getConfig());
});

app.put("/api/config", (req, res) => {
    const errors = simulator.setConfig(req.body);
    if (errors.length) return res.status(400).json({ errors });
    res.json(simulator.getConfig());
});

app.post("/api/start", (req, res) => {
    simulator.start();
    res.json(simulator.status());
});

app.post("/api/stop", (req, res) => {
    simulator.stop();
    res.json(simulator.status());
});

app.post("/api/reset", (req, res) => {
    simulator.reset();
    res.json(simulator.status());
});

app.post("/api/send-once", async (req, res) => {
    await simulator.sendOnce();
    res.json(simulator.status());
});

app.get("/api/preview", (req, res) => {
    res.json(simulator.preview());
});

app.get("/api/status", (req, res) => {
    res.json(simulator.status());
});

// Start the server
server = app.listen(PORT, () => {
    logger.info(`Server is running on http://localhost:${PORT}`);
});

//gracefull shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received.');
    simulator.stop();
    liveReload.closeStreams();
    server.close(() => {
        logger.info('Closed out remaining connections');
        // Additional cleanup tasks go here
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT signal received.');
    simulator.stop();
    liveReload.closeStreams();
    server.close(() => {
        logger.info('Closed out remaining connections');
        // Additional cleanup tasks go here
    });
});
