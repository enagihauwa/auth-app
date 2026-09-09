import * as rl from "./src/rateLimit.js";
console.log("limiters:", ["signinLimiter","signinPerIpLimiter","signupLimiter","forgotLimiter","resendLimiter","genericLimiter","checkoutLimiter"].every(k => typeof rl[k] === "function"));
