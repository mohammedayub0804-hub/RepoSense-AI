import { Router, type IRouter } from "express";
import {
  ExplainRepositoryBody,
  ExplainRepositoryParams,
  ExplainRepositoryResponse,
} from "@workspace/api-zod";
import { GitHubRequestError } from "../lib/repository-analysis";
import { generateRepositoryExplanation, RepositoryExplanationError } from "../lib/repository-explanations";

const router: IRouter = Router();
const aiRateLimitWindowMs = 60_000;
const maxAiRequestsPerWindow = 8;
const requestWindows = new Map<string, { startedAt: number; count: number }>();

function consumeAiRequest(ip: string): boolean {
  const now = Date.now();
  let window = requestWindows.get(ip);
  if (!window || now - window.startedAt >= aiRateLimitWindowMs) {
    window = { startedAt: now, count: 0 };
    requestWindows.set(ip, window);
  }
  if (window.count >= maxAiRequestsPerWindow) return false;
  window.count += 1;

  if (requestWindows.size > 1_000) {
    for (const [key, value] of requestWindows) {
      if (now - value.startedAt >= aiRateLimitWindowMs) requestWindows.delete(key);
    }
  }
  return true;
}

router.post(
  "/repositories/:owner/:repo/explanation",
  async (req, res): Promise<void> => {
    const params = ExplainRepositoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        error: "Enter a valid GitHub owner and repository name.",
        code: "INVALID_REPOSITORY",
      });
      return;
    }

    const { owner, repo } = params.data;
    if (
      !/^[A-Za-z0-9-]{1,39}$/.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
      repo === "." ||
      repo === ".."
    ) {
      res.status(400).json({
        error: "Enter a valid GitHub owner and repository name.",
        code: "INVALID_REPOSITORY",
      });
      return;
    }

    const body = ExplainRepositoryBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "Choose an explanation type and provide a question when asking about the repository.",
        code: "INVALID_EXPLANATION_REQUEST",
      });
      return;
    }
    if (body.data.mode === "question" && !body.data.question?.trim()) {
      res.status(400).json({
        error: "Enter a question about this repository.",
        code: "QUESTION_REQUIRED",
      });
      return;
    }

    if (!process.env.OPENAI_API_KEY?.trim()) {
      res.status(503).json({
        error:
          "AI explanations are not configured. Add OPENAI_API_KEY to Replit Secrets and restart the API server.",
        code: "AI_NOT_CONFIGURED",
      });
      return;
    }
    if (!consumeAiRequest(req.ip || req.socket.remoteAddress || "unknown")) {
      res.status(429).json({
        error: "Too many AI requests. Please wait a minute and try again.",
        code: "AI_RATE_LIMIT",
      });
      return;
    }

    try {
      const explanation = await generateRepositoryExplanation(
        owner,
        repo,
        body.data,
      );
      res.json(ExplainRepositoryResponse.parse(explanation));
    } catch (error) {
      if (error instanceof RepositoryExplanationError) {
        if (error.status >= 500) {
          req.log.warn(
            { code: error.code, owner, repo },
            "AI repository explanation failed",
          );
        }
        res.status(error.status).json({
          error: error.message,
          code: error.code,
        });
        return;
      }

      if (error instanceof GitHubRequestError) {
        if (error.rateLimited) {
          res.status(429).json({
            error:
              "GitHub’s public API limit has been reached. Please wait and try again.",
            code: "GITHUB_RATE_LIMIT",
          });
          return;
        }
        if (error.status === 404) {
          res.status(404).json({
            error:
              "Repository not found. Check the owner and repository name, and make sure it is public.",
            code: "REPOSITORY_NOT_FOUND",
          });
          return;
        }
      }

      req.log.error({ err: error, owner, repo }, "Repository explanation failed");
      res.status(502).json({
        error: "Could not retrieve repository evidence from GitHub. Please try again.",
        code: "GITHUB_REQUEST_FAILED",
      });
    }
  },
);

export default router;
