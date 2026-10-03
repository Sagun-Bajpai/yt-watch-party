const { io } = require("socket.io-client");

const SERVER_URL = process.env.SOCKET_TEST_URL || "http://localhost:5000";
const ACK_TIMEOUT_MS = 5000;

function connectSocket() {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, {
      autoConnect: false,
      reconnection: false,
      timeout: ACK_TIMEOUT_MS,
    });

    const handleConnect = () => {
      socket.off("connect_error", handleConnectError);
      resolve(socket);
    };
    const handleConnectError = (error) => {
      socket.off("connect", handleConnect);
      socket.disconnect();
      reject(error);
    };

    socket.once("connect", handleConnect);
    socket.once("connect_error", handleConnectError);
    socket.connect();
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${event} acknowledgement.`));
    }, ACK_TIMEOUT_MS);

    socket.emit(event, payload, (response) => {
      clearTimeout(timeout);
      resolve(response || {});
    });
  });
}

function emitAndWaitForError(socket, event, payload) {
  return new Promise((resolve, reject) => {
    let acknowledgement;
    let receivedError;

    const timeout = setTimeout(() => {
      socket.off("error", handleError);
      reject(new Error(`Did not receive an error event for ${event}.`));
    }, ACK_TIMEOUT_MS);

    const finish = () => {
      clearTimeout(timeout);
      socket.off("error", handleError);
      resolve(receivedError);
    };

    const handleError = (error) => {
      receivedError = error;
      if (acknowledgement?.error) {
        finish();
      }
    };

    socket.once("error", handleError);
    socket.emit(event, payload, (response) => {
      acknowledgement = response || {};
      if (!acknowledgement.error) {
        clearTimeout(timeout);
        socket.off("error", handleError);
        reject(new Error(`${event} unexpectedly succeeded.`));
      } else if (receivedError) {
        finish();
      }
    });
  });
}

function emitAndWaitForEvent(
  emitter,
  event,
  payload,
  receiver,
  expectedEvent,
) {
  return new Promise((resolve, reject) => {
    let acknowledgement;
    let receivedEvent;

    const timeout = setTimeout(() => {
      receiver.off(expectedEvent, handleEvent);
      reject(new Error(`Did not receive ${expectedEvent} after ${event}.`));
    }, ACK_TIMEOUT_MS);

    const finish = () => {
      clearTimeout(timeout);
      receiver.off(expectedEvent, handleEvent);
      resolve(receivedEvent);
    };

    const handleEvent = (data) => {
      receivedEvent = data;
      if (acknowledgement) {
        finish();
      }
    };

    receiver.once(expectedEvent, handleEvent);
    emitter.emit(event, payload, (response) => {
      acknowledgement = response || {};
      if (acknowledgement.error) {
        clearTimeout(timeout);
        receiver.off(expectedEvent, handleEvent);
        reject(new Error(acknowledgement.error));
      } else if (receivedEvent) {
        finish();
      }
    });
  });
}

async function main() {
  let hostSocket;
  let participantSocket;

  try {
    [hostSocket, participantSocket] = await Promise.all([
      connectSocket(),
      connectSocket(),
    ]);

    const createResponse = await emitWithAck(hostSocket, "create_room", {
      username: "Socket Test Host",
    });
    if (createResponse.error || !createResponse.roomId) {
      throw new Error(createResponse.error || "Room creation returned no roomId.");
    }

    const roomId = createResponse.roomId;
    const hostJoinError = await emitAndWaitForError(hostSocket, "join_room", {
      roomId,
      username: "Socket Test Host",
    });
    if (hostJoinError.message !== "You are already in this room.") {
      throw new Error(`Unexpected host join error: ${hostJoinError.message}`);
    }
    console.log(`Host joining own room error: ${hostJoinError.message}`);

    const joinResponse = await emitWithAck(participantSocket, "join_room", {
      roomId,
      username: "Socket Test Participant",
    });
    if (joinResponse.error) {
      throw new Error(joinResponse.error);
    }

    const controlPayload = { roomId };
    for (const [event, payload] of [
      ["play", controlPayload],
      ["change_video", { ...controlPayload, videoId: "socket-test-video" }],
      ["assign_role", {
        ...controlPayload,
        targetId: participantSocket.id,
        newRole: "Moderator",
      }],
    ]) {
      const error = await emitAndWaitForError(participantSocket, event, payload);
      console.log(`${event} error: ${error.message}`);
    }

    const assignResponse = await emitWithAck(hostSocket, "assign_role", {
      ...controlPayload,
      targetId: participantSocket.id,
      newRole: "Moderator",
    });
    if (assignResponse.error) {
      throw new Error(`Host could not assign Moderator: ${assignResponse.error}`);
    }

    const moderatorAssignError = await emitAndWaitForError(
      participantSocket,
      "assign_role",
      {
        ...controlPayload,
        targetId: hostSocket.id,
        newRole: "Participant",
      },
    );
    if (moderatorAssignError.message !== "Only the host can perform this action.") {
      throw new Error(`Unexpected Moderator assign_role error: ${moderatorAssignError.message}`);
    }
    console.log(`Moderator assign_role error: ${moderatorAssignError.message}`);

    const playResponse = await emitWithAck(participantSocket, "play", controlPayload);
    if (playResponse.error) {
      console.log(`play after promotion: rejected (${playResponse.error})`);
    } else {
      console.log("play after promotion: accepted");
    }

    const removedEvent = emitAndWaitForEvent(
      hostSocket,
      "remove_participant",
      {
        ...controlPayload,
        targetId: participantSocket.id,
      },
      participantSocket,
      "removed_from_room",
    );
    const removalNotice = await removedEvent;
    if (removalNotice.roomId !== roomId) {
      throw new Error("removed_from_room included an unexpected roomId.");
    }
    console.log("removed user received removed_from_room");
  } finally {
    hostSocket?.disconnect();
    participantSocket?.disconnect();
  }
}

main().catch((error) => {
  console.error(`Socket test failed: ${error.message}`);
  process.exitCode = 1;
});
