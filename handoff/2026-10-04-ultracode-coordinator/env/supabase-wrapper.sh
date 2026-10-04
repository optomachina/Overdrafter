#!/bin/sh
export SUPABASE_INTERNAL_IMAGE_REGISTRY="${SUPABASE_INTERNAL_IMAGE_REGISTRY:-docker.io}"
exec /usr/local/bin/supabase.real "$@"
