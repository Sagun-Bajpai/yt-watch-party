require("dotenv").config();

const cors = require("cors");
const express = require("express");
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const RoomManager = require("./RoomManager");
const registerRoomHandlers = require("./socket/roomHandler");

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const PORT = process.env.PORT || 5000;

const app = express();
app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

app.get("/health", (request, response) => {
  response.json({ status: "ok" });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
  },
});
const roomManager = new RoomManager();

io.on("connection", (socket) => {
  registerRoomHandlers(io, socket, roomManager);
});

if (require.main === module) {
  httpServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

module.exports = { app, httpServer, io, roomManager };
