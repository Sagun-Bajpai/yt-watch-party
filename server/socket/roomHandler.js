const User = require("../models/User");

function registerRoomHandlers(io, socket, roomManager) {
  if (!io || typeof io.to !== "function") {
    throw new Error("A Socket.IO server instance is required.");
  }
  if (!socket || typeof socket.on !== "function" || typeof socket.emit !== "function") {
    throw new Error("A Socket.IO socket instance is required.");
  }
  if (!roomManager || typeof roomManager.getRoom !== "function") {
    throw new Error("A RoomManager instance is required.");
  }

  const emitError = (error, acknowledge) => {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    socket.emit("error", { message });
    if (typeof acknowledge === "function") {
      acknowledge({ error: message });
    }
  };

  const run = (action) => (payload, acknowledge) => {
    try {
      const result = action(payload || {});
      if (typeof acknowledge === "function") {
        acknowledge({ success: true, ...result });
      }
    } catch (error) {
      emitError(error, acknowledge);
    }
  };

  const createUser = (username) => {
    if (typeof username !== "string" || username.trim() === "") {
      throw new Error("A non-empty username is required.");
    }
    return new User(socket.id, socket.id, username.trim());
  };

  const getRoom = (roomId) => {
    if (typeof roomId !== "string" || roomId.trim() === "") {
      throw new Error("A roomId is required.");
    }
    const room = roomManager.getRoom(roomId.trim().toUpperCase());
    if (!room) {
      throw new Error(`Room ${roomId} does not exist.`);
    }
    return room;
  };

  const assertCanControl = (room) => {
    if (!room.canControlPlayback(socket.id)) {
      throw new Error("You do not have permission to control playback.");
    }
  };

  const assertIsHost = (room) => {
    if (room.hostId !== socket.id) {
      throw new Error("Only the host can perform this action.");
    }
  };

  const getParticipants = (room) => room.getParticipantsList();

  const updatePlaybackState = (room, changes) => {
    room.videoState = {
      ...room.getCurrentState(),
      ...changes,
      updatedAt: Date.now(),
    };
    return { roomId: room.roomId, ...room.getCurrentState() };
  };

  socket.on("create_room", run((payload) => {
    const user = createUser(payload.username);
    const room = roomManager.createRoom(user);
    socket.join(room.roomId);
    const response = {
      roomId: room.roomId,
      user,
      participants: getParticipants(room),
    };
    socket.emit("room_created", response);
    return response;
  }));

  socket.on("join_room", run((payload) => {
    const room = getRoom(payload.roomId || payload.code);
    if (room.participants.has(socket.id)) {
      throw new Error("You are already in this room.");
    }
    const user = createUser(payload.username);
    room.addParticipant(user);
    socket.join(room.roomId);

    socket.emit("sync_state", {
      roomId: room.roomId,
      state: room.getCurrentState(),
      participants: getParticipants(room),
    });
    const participants = getParticipants(room);
    io.to(room.roomId).emit("user_joined", { user, participants });
    return { roomId: room.roomId, user, participants };
  }));

  socket.on("play", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    const currentState = room.getCurrentState();
    const currentTime = payload.currentTime === undefined
      ? currentState.currentTime
      : Number(payload.currentTime);
    if (!Number.isFinite(currentTime) || currentTime < 0) {
      throw new Error("currentTime must be a non-negative number.");
    }
    const state = updatePlaybackState(room, { currentTime, isPlaying: true });
    io.to(room.roomId).emit("play", state);
    return { state };
  }));

  socket.on("pause", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    const state = updatePlaybackState(room, {
      currentTime: room.getCurrentState().currentTime,
      isPlaying: false,
    });
    io.to(room.roomId).emit("pause", state);
    return { state };
  }));

  socket.on("seek", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    const currentTime = Number(payload.currentTime);
    if (!Number.isFinite(currentTime) || currentTime < 0) {
      throw new Error("currentTime must be a non-negative number.");
    }
    const state = updatePlaybackState(room, { currentTime });
    io.to(room.roomId).emit("seek", state);
    return { state };
  }));

  socket.on("change_video", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    if (typeof payload.videoId !== "string" || payload.videoId.trim() === "") {
      throw new Error("A non-empty videoId is required.");
    }
    const state = updatePlaybackState(room, {
      videoId: payload.videoId.trim(),
      currentTime: 0,
      isPlaying: false,
    });
    io.to(room.roomId).emit("change_video", state);
    return { state };
  }));

  socket.on("assign_role", run((payload) => {
    const room = getRoom(payload.roomId);
    assertIsHost(room);
    room.assignRole(socket.id, payload.targetId, payload.newRole);
    const participants = getParticipants(room);
    io.to(room.roomId).emit("role_assigned", {
      targetId: payload.targetId,
      role: payload.newRole,
      participants,
    });
    return { participants };
  }));

  socket.on("remove_participant", run((payload) => {
    const room = getRoom(payload.roomId);
    assertIsHost(room);
    const removed = room.removeByHost(socket.id, payload.targetId);
    const targetSocket = io.sockets && io.sockets.sockets
      ? io.sockets.sockets.get(removed.socketId)
      : null;
    if (targetSocket) {
      targetSocket.emit("removed_from_room", { roomId: room.roomId });
      targetSocket.leave(room.roomId);
    }
    roomManager.deleteIfEmpty(room.roomId);
    const participants = getParticipants(room);
    io.to(room.roomId).emit("participant_removed", {
      userId: removed.id,
      participants,
    });
    return { participants };
  }));

  socket.on("transfer_host", run((payload) => {
    const room = getRoom(payload.roomId);
    assertIsHost(room);
    room.transferHost(socket.id, payload.targetId);
    const participants = getParticipants(room);
    io.to(room.roomId).emit("role_assigned", {
      targetId: payload.targetId,
      role: "Host",
      participants,
    });
    return { participants };
  }));

  socket.on("leave_room", run((payload) => {
    const room = getRoom(payload.roomId);
    const user = roomManager.removeParticipant(room.roomId, socket.id);
    socket.leave(room.roomId);
    const participants = getParticipants(room);
    io.to(room.roomId).emit("user_left", {
      userId: user.id,
      participants,
    });
    return { participants };
  }));

  socket.on("disconnect", () => {
    for (const room of roomManager.rooms.values()) {
      const user = room.participants.get(socket.id);
      if (!user) {
        continue;
      }

      try {
        roomManager.removeParticipant(room.roomId, user.id);
        const participants = getParticipants(room);
        io.to(room.roomId).emit("user_left", {
          userId: user.id,
          participants,
        });
      } catch (error) {
        emitError(error);
      }
    }
  });
}

module.exports = registerRoomHandlers;
module.exports.registerRoomHandlers = registerRoomHandlers;
