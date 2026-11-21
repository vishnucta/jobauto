/** What "Prepare it for me" ends with (prepare-application.ts), for the screen that follows it. */
export type PrepareApplicationResult = {
  applicationId: string;
  /** How it's sent: the employer's form, an email, or by hand. */
  route: "web" | "email" | "none";
};
