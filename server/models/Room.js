const User = require("./User");

const ASSIGNABLE_ROLES = ["Moderator", "Participant"];

class Room {
  constructor(roomId, creator) {
    if (roomId === undefined || roomId === null) {
      throw new Error("Room id is required.");
    }
    if (!(creator instanceof User)) {
      throw new Error("Room creator must be a User.");
    }

    this.roomId = roomId;
    this.hostId = creator.id;
    this.participants = new Map();
    this.pendingRequests = new Map();
    this.messages = [];
    this.videoState = {
      videoId: null,
      isPlaying: false,
      currentTime: 0,
      updatedAt: Date.now(),
    };

    creator.role = "Host";
    this.participants.set(creator.id, creator);
  }

  addParticipant(user) {
    if (!(user instanceof User)) {
      throw new Error("Participant must be a User.");
    }
    if (this.participants.has(user.id)) {
      throw new Error(`User ${user.id} is already in the room.`);
    }

    user.role = "Participant";
    this.participants.set(user.id, user);
    return user;
  }

  removeParticipant(userId) {
    const user = this.participants.get(userId);
    if (!user) {
      throw new Error(`User ${userId} is not in the room.`);
    }

    this.participants.delete(userId);
    for (const [requestId, request] of this.pendingRequests) {
      if (request.requesterId === userId) {
        this.pendingRequests.delete(requestId);
      }
    }

    if (userId === this.hostId) {
      const nextHost = [...this.participants.values()].find(
        (participant) => participant.role === "Moderator",
      ) || [...this.participants.values()].find(
        (participant) => participant.role === "Participant",
      );

      this.hostId = nextHost ? nextHost.id : null;
      if (nextHost) {
        nextHost.role = "Host";
      }
    }

    return user;
  }

  canControlPlayback(userId) {
    const user = this.participants.get(userId);
    return Boolean(
      user && (user.role === "Host" || user.role === "Moderator"),
    );
  }

  assignRole(requesterId, targetId, newRole) {
    this._assertHost(requesterId);
    if (requesterId === targetId) {
      throw new Error("The host cannot assign a role to themselves.");
    }
    if (!ASSIGNABLE_ROLES.includes(newRole)) {
      throw new Error("New role must be Moderator or Participant.");
    }

    const target = this._getParticipant(targetId);
    target.role = newRole;
    return target;
  }

  removeByHost(requesterId, targetId) {
    this._assertHost(requesterId);
    if (requesterId === targetId) {
      throw new Error("The host cannot remove themselves.");
    }
    this._getParticipant(targetId);
    return this.removeParticipant(targetId);
  }

  transferHost(requesterId, targetId) {
    this._assertHost(requesterId);
    if (requesterId === targetId) {
      throw new Error("The host cannot transfer host status to themselves.");
    }

    const currentHost = this._getParticipant(requesterId);
    const target = this._getParticipant(targetId);
    currentHost.role = "Moderator";
    target.role = "Host";
    this.hostId = target.id;
    return target;
  }

  getCurrentState() {
    const now = Date.now();
    const elapsed = this.videoState.isPlaying
      ? Math.max(0, now - this.videoState.updatedAt) / 1000
      : 0;

    return {
      ...this.videoState,
      currentTime: this.videoState.currentTime + elapsed,
      updatedAt: now,
    };
  }

  getParticipantsList() {
    return [...this.participants.values()];
  }

  _assertHost(requesterId) {
    if (requesterId !== this.hostId) {
      throw new Error("Only the host can perform this action.");
    }
    this._getParticipant(requesterId);
  }

  _getParticipant(userId) {
    const participant = this.participants.get(userId);
    if (!participant) {
      throw new Error(`User ${userId} is not in the room.`);
    }
    return participant;
  }
}

module.exports = Room;
module.exports.Room = Room;
