FROM supabase/realtime:v2.78.10
USER root
RUN sed -i 's/socket_opts: \[:inet6\]/socket_opts: [:inet]/' /app/releases/2.78.10/runtime.exs && grep -n "socket_opts" /app/releases/2.78.10/runtime.exs
