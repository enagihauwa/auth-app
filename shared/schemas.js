import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .min(3, "Email is required.")
  .max(320, "Email is too long.")
  .email("Enter a valid email address.");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128, "Password must be at most 128 characters.")
  .regex(/[a-z]/, "Password needs a lowercase letter.")
  .regex(/[A-Z]/, "Password needs an uppercase letter.")
  .regex(/[0-9]/, "Password needs a number.");

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(100, "Name is too long."),
  email: emailSchema,
  password: passwordSchema,
});

export const signinSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required.").max(128, "Password is too long."),
});

export const verifySchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "The code is six digits.")
    .refine((c) => c !== "000000", "The code is six digits."),
});

export const forgotSchema = z.object({
  email: emailSchema,
});

export const resetSchema = z.object({
  token: z.string().trim().min(20, "The reset link is invalid or has expired."),
  password: passwordSchema,
});

export const resendSchema = z.object({
  email: emailSchema,
});

export const signupFormSchema = signupSchema.extend({
  confirmPassword: z.string().min(1, "Confirm your password."),
});

export const resetFormSchema = resetSchema.extend({
  confirmPassword: z.string().min(1, "Confirm your password."),
});