import mongoose from "mongoose";
export default async function connectDB(uri: string): Promise<void> {
  mongoose.set("bufferCommands", false);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
}
