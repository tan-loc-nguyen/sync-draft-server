import { Request } from 'express';

// Every /api route sits behind the JWT middleware, so `auth` is always present
// at runtime. This narrows the optional type in one place instead of scattering
// non-null assertions across the routes, and fails loudly if a route is ever
// mounted outside the middleware.
export const userIdFrom = (req: Request): string => {
  const sub = req.auth?.payload.sub;

  if (!sub) {
    throw new Error('Protected route reached without a verified token subject');
  }

  return sub;
};
