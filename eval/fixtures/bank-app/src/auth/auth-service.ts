import { ForbiddenError, type User } from "../accounts/account.js";

const IDENTITY_URL = "https://identity.example.com/v1/me";

export class AuthService {
  /** Looks up the user a bearer token belongs to. */
  async authenticate(token: string | undefined): Promise<User> {
    if (!token) {
      throw new ForbiddenError("Missing token");
    }
    try {
      const response = await fetch(IDENTITY_URL, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) {
        throw new ForbiddenError("Invalid token");
      }
      return (await response.json()) as User;
    } catch (error) {
      if (error instanceof ForbiddenError) throw error;
      throw new ForbiddenError("Identity service unavailable");
    }
  }
}
