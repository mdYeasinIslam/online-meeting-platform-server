import express from "express";
import type { Request, Response } from "express";
import cors from "cors";

const app = express();
//middle Ware
//Must remove "/" from your production URL
app.use(
  cors({
    origin: ["http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  }),
);
app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.send("Hello TS Server");
});

export default app;
