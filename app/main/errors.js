// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// API errors are plain { code, message } with a user-facing message.
class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
  toJSON() { return { code: this.code, message: this.message }; }
}

const notReady = () => new ApiError('not-ready', 'This part of OmniDesk is still being built.');
const badArgs = (what) => new ApiError('bad-args', `That request was not valid${what ? ` (${what})` : ''}.`);

module.exports = { ApiError, notReady, badArgs };
