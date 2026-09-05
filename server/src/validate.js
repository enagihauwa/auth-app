export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0] ?? "_";
        if (!issues[key]) issues[key] = [];
        issues[key].push(issue.message);
      }
      return res.status(400).json({ error: "Check the highlighted fields.", issues });
    }
    req.body = result.data;
    next();
  };
}