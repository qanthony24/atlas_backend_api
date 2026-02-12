
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// Extend Express Request type to include our Context
declare global {
    namespace Express {
        interface Request {
            context: {
                requestId: string;
                userId: string;
                orgId: string;
                role: 'admin' | 'canvasser';
            }
        }
    }
}

/**
 * AUTH & TENANCY HANDSHAKE
 * 
 * This middleware strictly enforces the "Context" required for the backend.
 * It ensures that NO request proceeds to business logic without a valid Org ID.
 */
export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({ error: 'Missing Authorization Header' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret') as any;

        if (!decoded.org_id || !decoded.sub) {
            throw new Error('Invalid Token Claims');
        }

        // SET CONTEXT
        // This is the source of truth for all downstream controllers.
        // They must NEVER read org_id from body/query params for security.
        req.context = {
            requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
            userId: decoded.sub,
            orgId: decoded.org_id,
            role: decoded.role
        };

        // Logger hook for Observability (Requirement 5)
        console.log(JSON.stringify({
            level: 'info',
            msg: 'Request Authenticated',
            request_id: req.context.requestId,
            org_id: req.context.orgId,
            user_id: req.context.userId,
            path: req.path
        }));

        next();

    } catch (err) {
        return res.status(401).json({ error: 'Invalid or Expired Token' });
    }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (req.context.role !== 'admin') {
        return res.status(403).json({ error: 'Insufficient Permissions' });
    }
    next();
};

export const requireInternal = (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.split(' ')[1] || req.headers['x-internal-token'];
    if (!token || token !== (process.env.INTERNAL_ADMIN_TOKEN || 'internal_dev_token')) {
        return res.status(403).json({ error: 'Internal access only' });
    }
    next();
};
