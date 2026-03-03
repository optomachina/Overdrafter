import { useLocation } from "react-router-dom";
import { useEffect } from "react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="rounded-3xl border border-white/10 bg-white/5 p-10 text-center backdrop-blur-xl">
        <h1 className="mb-4 text-5xl font-semibold">404</h1>
        <p className="mb-4 text-lg text-white/60">The route you requested does not exist in this app.</p>
        <a href="/" className="text-primary underline-offset-4 hover:underline">
          Return to Home
        </a>
      </div>
    </div>
  );
};

export default NotFound;
