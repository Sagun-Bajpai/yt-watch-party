const { randomInt } = require("node:crypto");
const Room = require("./models/Room");

const ROOM_CODE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(creator) {
    let roomId;
    do {
      roomId = this._generateRoomCode();
    } while (this.rooms.has(roomId));

    const room = new Room(roomId, creator);
    this.rooms.set(roomId, room);
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  deleteRoom(roomId) {
    return this.rooms.delete(roomId);
  }

  removeParticipant(roomId, userId) {
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} does not exist.`);
    }

    const participant = room.removeParticipant(userId);
    if (room.participants.size === 0) {
      this.deleteRoom(roomId);
    }
    return participant;
  }

  deleteIfEmpty(roomId) {
    const room = this.getRoom(roomId);
    if (room && room.participants.size === 0) {
      this.deleteRoom(roomId);
      return true;
    }
    return false;
  }

  _generateRoomCode() {
    return Array.from(
      { length: ROOM_CODE_LENGTH },
      () => ROOM_CODE_CHARACTERS[randomInt(ROOM_CODE_CHARACTERS.length)],
    ).join("");
  }
}

module.exports = RoomManager;
module.exports.RoomManager = RoomManager;
