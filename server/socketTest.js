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

function waitForEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handleEvent);
      reject(new Error(`Did not receive ${event}.`));
    }, ACK_TIMEOUT_MS);
    const handleEvent = (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    };
    socket.once(event, handleEvent);
  });
}

function waitForNoEvent(socket, event, durationMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handleEvent);
      resolve();
    }, durationMs);
    const handleEvent = () => {
      clearTimeout(timeout);
      reject(new Error(`Unexpectedly received ${event}.`));
    };
    socket.once(event, handleEvent);
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
    const participantResolveError = await emitAndWaitForError(
      participantSocket,
      "resolve_request",
      { ...controlPayload, requestId: "not-a-request", approve: true },
    );
    if (participantResolveError.message !== "You do not have permission to control playback.") {
      throw new Error(`Unexpected Participant resolve_request error: ${participantResolveError.message}`);
    }
    console.log(`Participant resolve_request error: ${participantResolveError.message}`);

    const firstHostRequest = waitForEvent(hostSocket, "change_requested");
    const firstRequestSent = waitForEvent(participantSocket, "request_sent");
    const firstRequestAck = emitWithAck(participantSocket, "request_change", {
      ...controlPayload,
      type: "play",
      payload: { currentTime: 12 },
    });
    const [playRequest, sentNotice, sentAck] = await Promise.all([
      firstHostRequest,
      firstRequestSent,
      firstRequestAck,
    ]);
    if (sentAck.error || sentNotice.requestId !== playRequest.requestId) {
      throw new Error("The request was not acknowledged consistently.");
    }
    if (
      playRequest.requesterId !== participantSocket.id
      || playRequest.requesterName !== "Socket Test Participant"
      || playRequest.type !== "play"
    ) {
      throw new Error("The Host received an invalid change_requested payload.");
    }
    const approvedPlay = waitForEvent(participantSocket, "play");
    const approveAck = await emitWithAck(hostSocket, "resolve_request", {
      ...controlPayload,
      requestId: playRequest.requestId,
      approve: true,
    });
    const approvedState = await approvedPlay;
    if (approveAck.error || !approvedState.isPlaying || approvedState.currentTime < 12) {
      throw new Error("Approving the play request did not apply the playback change.");
    }
    console.log("Participant play request reached Host and approval applied");

    const rejectedHostRequest = waitForEvent(hostSocket, "change_requested");
    const rejectedRequestSent = waitForEvent(participantSocket, "request_sent");
    const rejectedRequestAck = emitWithAck(participantSocket, "request_change", {
      ...controlPayload,
      type: "change_video",
      payload: { videoId: "rejected-video" },
    });
    const [videoRequest, rejectedNotice, videoRequestAck] = await Promise.all([
      rejectedHostRequest,
      rejectedRequestSent,
      rejectedRequestAck,
    ]);
    if (videoRequestAck.error || rejectedNotice.requestId !== videoRequest.requestId) {
      throw new Error("The video change request was not acknowledged.");
    }
    const resolutionNotice = waitForEvent(participantSocket, "request_resolved");
    const noVideoBroadcast = waitForNoEvent(participantSocket, "change_video", 350);
    const rejectAck = await emitWithAck(hostSocket, "resolve_request", {
      ...controlPayload,
      requestId: videoRequest.requestId,
      approve: false,
    });
    const rejectedResolution = await resolutionNotice;
    await noVideoBroadcast;
    if (rejectAck.error || rejectedResolution.requestId !== videoRequest.requestId || rejectedResolution.approved) {
      throw new Error("Rejecting the video request did not notify the requester correctly.");
    }
    console.log("Rejected video request did not apply the change");

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
