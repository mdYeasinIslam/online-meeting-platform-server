require("dotenv").config({ override: false });
import http from "http";
import app from "./App";
import connectDB from "./app/config/database";

let server = http.createServer(app);
const PORT = process.env.PORT || 5000;

async function main() {
  await connectDB();
  server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}

main().catch((err) => {
  console.error("Error starting server:", err);
});
