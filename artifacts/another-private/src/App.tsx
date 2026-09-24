import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { RealtimeTransportProvider } from '@/providers/realtime-transport';

import Login from '@/pages/login';
import Register from '@/pages/register';
import AppLayout from '@/pages/app-layout';
import AdminPanel from '@/pages/admin-panel';

const queryClient = new QueryClient();

function Router() {
  const [location] = useLocation();
  const routes = (
    <Switch>
      <Route path="/" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/app" component={AppLayout} />
      <Route path="/app/admin" component={AdminPanel} />
      <Route component={NotFound} />
    </Switch>
  );

  return location.startsWith('/app')
    ? <RealtimeTransportProvider>{routes}</RealtimeTransportProvider>
    : routes;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="aeronight-atmosphere" aria-hidden="true">
          <div className="aeronight-stars" />
          <div className="aeronight-wave aeronight-wave--near" />
          <div className="aeronight-wave aeronight-wave--far" />
        </div>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
