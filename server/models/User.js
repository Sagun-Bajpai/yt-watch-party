const ROLES = ["Host", "Moderator", "Participant"];

class User {
  constructor(id, socketId, username, role = "Participant") {
    if (id === undefined || id === null) {
      throw new Error("User id is required.");
    }
    if (socketId === undefined || socketId === null) {
      throw new Error("User socketId is required.");
    }
    if (typeof username !== "string" || username.trim() === "") {
      throw new Error("User username must be a non-empty string.");
    }
    if (!ROLES.includes(role)) {
      throw new Error(`Invalid user role: ${role}.`);
    }

    this.id = id;
    this.socketId = socketId;
    this.username = username;
    this.role = role;
  }
}

module.exports = User;
module.exports.User = User;
