export async function handler(event) {
  const domain = process.env.CAMPUS_EMAIL_DOMAIN;
  const email = event.request?.userAttributes?.email;
  const parts = typeof email === 'string' ? email.trim().toLowerCase().split('@') : [];
  if (!domain || parts.length !== 2 || !parts[0] || parts[1] !== domain) {
    throw new Error('Use an email address from your campus.');
  }
  // Cognito sends the confirmation code and verifies the email.
  return event;
}
