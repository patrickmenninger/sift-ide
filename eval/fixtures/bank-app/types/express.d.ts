// Minimal stand-in for Express 5 types.
declare module "express" {
  export interface Request {
    params: Record<string, string>;
    body: unknown;
    header(name: string): string | undefined;
  }
  export interface Response {
    status(code: number): Response;
    json(body: unknown): Response;
  }
  export type Handler = (req: Request, res: Response) => unknown;

  export interface Router {
    get(path: string, ...handlers: Handler[]): Router;
    post(path: string, ...handlers: Handler[]): Router;
  }
  export interface Application extends Router {
    use(router: Router): Application;
    listen(port: number, callback?: () => void): void;
  }

  function express(): Application;
  namespace express {
    function Router(): Router;
  }
  export default express;
}
