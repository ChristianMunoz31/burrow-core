// The optional user-name line of Javi's prompts. Pure (no I/O), shared by the page advisor and the Pro prompts.

/**
 * One line telling the model the user's name, or '' when it is unknown.
 * The name is already sanitized (control characters stripped, length-capped) by profile.js.
 *
 * @param {string | null | undefined} displayName
 * @returns {string}
 */
export function userNameLine(displayName) {
  return typeof displayName === 'string' && displayName.trim()
    ? `The user's name is ${displayName.trim()}. Use it occasionally, never in every reply.`
    : '';
}
