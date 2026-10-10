import { Router, type IRouter } from "express";
import { AnalyzeRepositoryParams } from "@workspace/api-zod";
import {
  analyzeGitHubRepository,
  GitHubRequestError,
} from "../lib/repository-analysis";

const router: IRouter = Router();

router.get(
  "/repositories/:owner/:repo",
  async (req, res): Promise<void> => {
    const params = AnalyzeRepositoryParams.safeParse(req.params);
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

    try {
      const analysis = await analyzeGitHubRepository(owner, repo);
      res.json(analysis);
    } catch (error) {
      if (error instanceof GitHubRequestError) {
        if (error.rateLimited) {
          res.status(429).json({
            error:
              "GitHub’s public API limit has been reached. Please wait a minute and try again.",
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
        req.log.warn(
          { status: error.status, owner, repo },
          "GitHub repository request failed",
        );
        res.status(502).json({
          error: "GitHub could not complete the request. Please try again.",
          code: "GITHUB_REQUEST_FAILED",
        });
        return;
      }

      req.log.error({ err: error, owner, repo }, "Repository analysis failed");
      res.status(502).json({
        error:
          "Could not reach GitHub right now. Check your connection and try again.",
        code: "GITHUB_NETWORK_ERROR",
      });
    }
  },
);

export default router;
