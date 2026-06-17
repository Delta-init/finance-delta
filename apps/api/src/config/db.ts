import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "../lib/logger";

export async function connectDb(): Promise<typeof mongoose> {
  
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI);
  logger.info("MongoDB connected");
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
