import mongoose from "mongoose";

const connectDB = async (): Promise<void> => {
  const url = process.env.MONGODB_URI as string;
  try {
    await mongoose.connect(url);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
  }
};
export default connectDB;

