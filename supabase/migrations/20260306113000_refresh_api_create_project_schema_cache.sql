drop function if exists public.api_create_project(text);

grant execute on function public.api_create_project(text, text) to authenticated;

notify pgrst, 'reload schema';
