// Lets routes map a controller failure onto the right status code without
// inspecting error messages.
export class NotFoundError extends Error {}

export class ForbiddenError extends Error {}
