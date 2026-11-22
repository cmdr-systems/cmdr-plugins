// agent-client: the plugin's internal library (local-agents design § 3.3, 0.1.8), one SDK for two faces, the MCP
// channel (this plugin) and the cmdr-agent CLI (S6). Imported by relative path; it has no package.json of its own
// (design 0.1.9, T-1) and its runtime dependencies are the plugin's. It imports nothing from the plugin.
export { apiError, CAPABILITIES, GENERAL_CHANNEL_CAPABILITY, McClient, PLUGIN_VERSION, type Api, type ApiInit, type McClientOptions, type Me, type Thread } from './client.js'
export { ADMITTED_BOTS, Admission, GENERAL, Hearing, hearsOf, isFeed, isQueueArchetype, mentionOf, PEOPLE_REFRESH_MS, UNKNOWN_REFRESH_MS, type HearsView, type Person, type Role } from './hearing.js'
export { ACTIVITY_STATE_FILE, Session, SESSION_DECLARE_TIMEOUT_MS, SessionRefused, type DeclareSocket, type SessionOk, type SessionScope } from './session.js'
export { clearLink, Link, LINK_FILE, LINK_TIMEOUT_MS, MIRROR_TIMEOUT_MS, readLink, writeLink, type LinkDeps, type LinkTarget, type TerminalLink } from './link.js'
export { CHANNEL_TAG, Mode, MODE_FILE, modeOf, openerOf, type Opener } from './mode.js'
export type { Attachment, Author, Conversation, Message, ReactionView } from './types.js'
