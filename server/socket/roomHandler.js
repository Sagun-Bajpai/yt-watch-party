const { randomUUID } = require("node:crypto");
const User = require("../models/User");

const REQUESTABLE_CHANGES = new Set(["play", "pause", "seek", "change_video"]);
const REQUEST_TTL_MS = 60_000;

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

  const assertIsParticipant = (room) => {
    const user = room.participants.get(socket.id);
    if (!user || user.role !== "Participant") {
      throw new Error("Only Participants can request changes.");
    }
    return user;
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

  const validateChange = (type, payload) => {
    if (!REQUESTABLE_CHANGES.has(type)) {
      throw new Error("type must be play, pause, seek, or change_video.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("A change payload is required.");
    }

    if (type === "play") {
      const currentTime = payload.currentTime === undefined
        ? undefined
        : Number(payload.currentTime);
      if (currentTime !== undefined && (!Number.isFinite(currentTime) || currentTime < 0)) {
        throw new Error("currentTime must be a non-negative number.");
      }
      return { currentTime };
    }
    if (type === "seek") {
      const currentTime = Number(payload.currentTime);
      if (!Number.isFinite(currentTime) || currentTime < 0) {
        throw new Error("currentTime must be a non-negative number.");
      }
      return { currentTime };
    }
    if (type === "change_video") {
      if (typeof payload.videoId !== "string" || payload.videoId.trim() === "") {
        throw new Error("A non-empty videoId is required.");
      }
      return { videoId: payload.videoId.trim() };
    }
    return {};
  };

  const applyChange = (room, type, payload) => {
    const validatedPayload = validateChange(type, payload);
    let changes;
    if (type === "play") {
      const currentTime = validatedPayload.currentTime === undefined
        ? room.getCurrentState().currentTime
        : validatedPayload.currentTime;
      changes = { currentTime, isPlaying: true };
    } else if (type === "pause") {
      changes = {
        currentTime: room.getCurrentState().currentTime,
        isPlaying: false,
      };
    } else if (type === "seek") {
      changes = { currentTime: validatedPayload.currentTime };
    } else {
      changes = {
        videoId: validatedPayload.videoId,
        currentTime: 0,
        isPlaying: false,
      };
    }

    const state = updatePlaybackState(room, changes);
    io.to(room.roomId).emit(type, state);
    return { state };
  };

  const getApprovers = (room) => [...room.participants.values()].filter(
    (user) => user.role === "Host" || user.role === "Moderator",
  );

  const emitToApprovers = (room, event, payload, excludedSocketId) => {
    for (const user of getApprovers(room)) {
      if (user.socketId === excludedSocketId) {
        continue;
      }
      const targetSocket = io.sockets?.sockets?.get(user.socketId);
      targetSocket?.emit(event, payload);
    }
  };

  const notifyRequestRemoved = (room, request, approved, notifyRequester = true) => {
    const resolution = { requestId: request.requestId, approved };
    if (notifyRequester) {
      const requesterSocket = io.sockets?.sockets?.get(request.requesterId);
      requesterSocket?.emit("request_resolved", resolution);
    }
    emitToApprovers(room, "request_resolved", resolution);
  };

  const removeRequestsForUser = (room, userId) => {
    const removedRequests = [...room.pendingRequests.values()].filter(
      (request) => request.requesterId === userId,
    );
    return removedRequests;
  };

  const publishRemovedRequests = (room, requests) => {
    for (const request of requests) {
      notifyRequestRemoved(room, request, false, false);
    }
  };

  const sendPendingRequests = (room, userId) => {
    const user = room.participants.get(userId);
    if (!user || (user.role !== "Host" && user.role !== "Moderator")) {
      return;
    }
    const targetSocket = io.sockets?.sockets?.get(user.socketId);
    for (const request of room.pendingRequests.values()) {
      targetSocket?.emit("change_requested", request);
    }
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
      messages: room.messages,
    });
    const participants = getParticipants(room);
    io.to(room.roomId).emit("user_joined", { user, participants });
    return { roomId: room.roomId, user, participants };
  }));

  socket.on("play", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    return applyChange(room, "play", payload);
  }));

  socket.on("pause", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    return applyChange(room, "pause", payload);
  }));

  socket.on("seek", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    return applyChange(room, "seek", payload);
  }));

  socket.on("change_video", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    return applyChange(room, "change_video", payload);
  }));

  socket.on("send_message", run((payload) => {
    const room = getRoom(payload.roomId);
    const user = room.participants.get(socket.id);
    if (!user) {
      throw new Error("You must be in the room to send a message.");
    }
    if (typeof payload.text !== "string") {
      throw new Error("Message text must be a string.");
    }
    const text = payload.text.trim();
    if (!text) {
      throw new Error("Message text cannot be empty.");
    }
    if (text.length > 300) {
      throw new Error("Message text cannot exceed 300 characters.");
    }

    const message = {
      userId: user.id,
      username: user.username,
      role: user.role,
      text,
      timestamp: Date.now(),
    };
    room.messages.push(message);
    if (room.messages.length > 50) {
      room.messages.splice(0, room.messages.length - 50);
    }
    io.to(room.roomId).emit("new_message", message);
    return { message };
  }));

  socket.on("request_change", run((payload) => {
    const room = getRoom(payload.roomId);
    const requester = assertIsParticipant(room);
    if ([...room.pendingRequests.values()].some(
      (request) => request.requesterId === requester.id,
    )) {
      throw new Error("You already have a pending request.");
    }

    const changePayload = validateChange(payload.type, payload.payload);
    const request = {
      requestId: randomUUID(),
      requesterId: requester.id,
      requesterName: requester.username,
      type: payload.type,
      payload: changePayload,
      createdAt: Date.now(),
    };
    room.pendingRequests.set(request.requestId, request);
    emitToApprovers(room, "change_requested", request);
    socket.emit("request_sent", { requestId: request.requestId });

    const expiryTimer = setTimeout(() => {
      if (roomManager.getRoom(room.roomId) !== room) {
        return;
      }
      const expiredRequest = room.pendingRequests.get(request.requestId);
      if (!expiredRequest) {
        return;
      }
      room.pendingRequests.delete(request.requestId);
      notifyRequestRemoved(room, expiredRequest, false);
    }, REQUEST_TTL_MS);
    expiryTimer.unref?.();

    return { requestId: request.requestId };
  }));

  socket.on("resolve_request", run((payload) => {
    const room = getRoom(payload.roomId);
    assertCanControl(room);
    if (typeof payload.approve !== "boolean") {
      throw new Error("approve must be a boolean.");
    }
    const request = room.pendingRequests.get(payload.requestId);
    if (!request) {
      throw new Error("This request no longer exists.");
    }

    room.pendingRequests.delete(request.requestId);
    if (payload.approve) {
      applyChange(room, request.type, request.payload);
    }
    notifyRequestRemoved(room, request, payload.approve);
    return { requestId: request.requestId, approved: payload.approve };
  }));

  socket.on("assign_role", run((payload) => {
    const room = getRoom(payload.roomId);
    assertIsHost(room);
    room.assignRole(socket.id, payload.targetId, payload.newRole);
    sendPendingRequests(room, payload.targetId);
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
    const removedRequests = removeRequestsForUser(room, payload.targetId);
    const removed = room.removeByHost(socket.id, payload.targetId);
    publishRemovedRequests(room, removedRequests);
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
    sendPendingRequests(room, payload.targetId);
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
    const removedRequests = removeRequestsForUser(room, socket.id);
    const user = roomManager.removeParticipant(room.roomId, socket.id);
    publishRemovedRequests(room, removedRequests);
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
        const removedRequests = removeRequestsForUser(room, user.id);
        roomManager.removeParticipant(room.roomId, user.id);
        publishRemovedRequests(room, removedRequests);
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
