import express, { Express } from "express";
import { Server as SocketIOServer } from 'socket.io';
import { createServer, Server as HttpServer } from 'http';
import cors from 'cors';
import { Redis } from "ioredis";
import './config/env.js';

import connectPrisma from "./config/prisma.js";
import api from "./api/index.js";
import connectRedis from "./config/redis.js";
import socket from "./socket/index.js";

export class SyncServer {
  #server: HttpServer

  #app: Express

  #io: SocketIOServer

  #redis!: Redis
  constructor() {
    this.#app = express();
    this.#server = createServer(this.#app);
    this.#io = new SocketIOServer(this.#server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE']
      }
    })
  }

  async start() {
    const PORT = process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030;
    // Connect to PostgreSQL
    await this.connectDBSync();
    // Connect to local redis server
    await this.connectRedisSync();

    this.#app.use(express.json());
    this.#app.use(cors());

    // Rest API
    api(this.#app, this.#redis);

    // Socket
    await socket(this.#io, this.#redis);

    this.#server.listen(PORT, () => {
      console.log(`[Server] Server is running at http://localhost:${PORT}`);
    })
  }

  async connectDBSync() {
    await connectPrisma();
  }

  async connectRedisSync() {
    this.#redis = await connectRedis();
    this.#redis.on('error', (err) => {
      console.log('[Redis] Connection error:', err);
    });
  }
}

