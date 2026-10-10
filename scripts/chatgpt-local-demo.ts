import { startLocalChatGptDemo } from "../server/chatgpt/local-demo";
import { syntheticJobId } from "../server/chatgpt/synthetic-fixture";

const demo = await startLocalChatGptDemo(process.env.OVD_CHATGPT_LOCAL_DEMO === "1");
console.log(JSON.stringify({ mode: "synthetic-only", url: `${demo.origin}/mcp`, bearer: demo.bearer, jobId: syntheticJobId }));
process.once("SIGINT", () => void demo.close());
process.once("SIGTERM", () => void demo.close());
