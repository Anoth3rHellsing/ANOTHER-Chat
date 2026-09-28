import { useState, useMemo, useRef, useEffect } from 'react';
import { 
  useListChannelEvents, 
  useCreateChannelEvent,
  useGetChannelEvent,
  useUpdateChannelEvent,
  useCancelChannelEvent,
  useRespondToChannelEvent,
  getListChannelEventsQueryKey,
  getGetChannelEventQueryKey,
  getListMyUpcomingEventsQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Calendar, Clock, MapPin, Check, X as XIcon, HelpCircle, AlertCircle, CalendarPlus, ChevronRight, Users as UsersIcon, Plus } from 'lucide-react';
import { useRealtimeMessages } from '@/providers/realtime-transport';
import { convertToUTC, formatEventTime, validateLocalTime } from '@/lib/event-time';
import { hasPerm, PERM } from '@/lib/permissions';
import { useToast } from '@/hooks/use-toast';
import { sameOriginUploadUrl } from '@/lib/media-url';

// Add realtime invalidation hook
export function useEventRealtime() {
  const queryClient = useQueryClient();
  useRealtimeMessages(
    ['event:created', 'event:updated', 'event:cancelled', 'event:rsvp_updated'],
    (payload: any) => {
      const channelId = payload.data?.channelId;
      const eventId = payload.data?.eventId || payload.data?.id;
      if (channelId) {
        queryClient.invalidateQueries({ queryKey: getListChannelEventsQueryKey(channelId) });
        queryClient.invalidateQueries({ queryKey: getListMyUpcomingEventsQueryKey() });
        if (eventId) {
          queryClient.invalidateQueries({ queryKey: getGetChannelEventQueryKey(channelId, eventId) });
        }
      }
    }
  );
}

export function ChannelEventsEntry({ channelName, open, onClick }: {
  channelName: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${open ? 'bg-primary/20 text-primary' : 'text-primary hover:bg-primary/10'}`}
      aria-label={`Eventos del canal ${channelName}`}
      aria-expanded={open}
      aria-controls="channel-events-panel"
      title="Eventos del canal: próximos, pasados y crear evento"
    >
      <Calendar className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>Eventos</span>
    </button>
  );
}

// Inline Message Card
export function EventMessageCard({ eventId, channelId, onOpenEvents }: { eventId: number, channelId: number, onOpenEvents: () => void }) {
  const { data: event, isLoading, error } = useGetChannelEvent(channelId, eventId, {
    query: {
      queryKey: getGetChannelEventQueryKey(channelId, eventId),
      retry: false
    }
  });

  if (isLoading) {
    return <div className="mt-2 h-16 bg-white/5 animate-pulse rounded-lg border border-white/10 max-w-sm" />;
  }

  if (error || !event) {
    return (
      <div className="mt-2 p-3 bg-secondary/50 border border-white/10 rounded-lg max-w-sm flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground italic">Este evento ya no está disponible.</p>
      </div>
    );
  }

  const { formattedLocal, ianaLocal } = formatEventTime(event.startsAt, event.originalTimeZone);

  return (
    <div className="mt-2 bg-card/40 border border-primary/20 rounded-lg overflow-hidden max-w-sm hover:border-primary/40 transition-colors group">
      <div className="bg-primary/10 px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary font-medium text-sm">
          <Calendar className="w-4 h-4" />
          <span>Evento Anunciado</span>
        </div>
        {event.canceledAt && (
          <span className="text-[10px] font-mono bg-destructive/20 text-destructive px-1.5 py-0.5 rounded">CANCELADO</span>
        )}
      </div>
      <div className="p-3">
        <h4 className="font-semibold text-foreground mb-1 line-clamp-1">{event.title}</h4>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
          <Clock className="w-3.5 h-3.5" />
          <span>{formattedLocal} ({ianaLocal})</span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1 text-primary" title="Asistirán"><Check className="w-3 h-3"/> {event.counts.yes}</span>
            <span className="flex items-center gap-1 text-foreground/70" title="Tal vez"><HelpCircle className="w-3 h-3"/> {event.counts.maybe}</span>
            <span className="flex items-center gap-1 text-destructive" title="No asistirán"><XIcon className="w-3 h-3"/> {event.counts.no}</span>
          </div>
          <button 
            onClick={onOpenEvents}
            className="text-xs font-medium text-primary hover:text-primary-foreground hover:bg-primary px-2 py-1 rounded transition-colors"
          >
            Ver Detalles
          </button>
        </div>
      </div>
    </div>
  );
}

// Right panel
export function ChannelEventsPanel({ 
  channelId, 
  onClose,
  currentUser,
  userPermissions,
  layout = 'panel',
}: { 
  channelId: number, 
  onClose: () => void,
  currentUser: any,
  userPermissions: number,
  layout?: 'panel' | 'main',
}) {
  const { data: events, isLoading } = useListChannelEvents(channelId, {
    query: { queryKey: getListChannelEventsQueryKey(channelId) }
  });
  
  const [view, setView] = useState<'list' | 'create' | 'edit'>('list');
  const [editingEvent, setEditingEvent] = useState<any>(null);

  const canManage = (creatorId: number) => {
    if (creatorId === currentUser.id) return true;
    return hasPerm(userPermissions, PERM.MANAGE_CHANNELS);
  };

  const upcomingEvents = useMemo(() => {
    if (!events) return [];
    return events.filter(e => !e.canceledAt && new Date(e.startsAt) >= new Date()).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }, [events]);

  const pastEvents = useMemo(() => {
    if (!events) return [];
    return events.filter(e => e.canceledAt || new Date(e.startsAt) < new Date()).sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());
  }, [events]);

  const isMainLayout = layout === 'main';

  return (
    <div
      id={isMainLayout ? 'channel-events-calendar' : 'channel-events-panel'}
      data-testid={isMainLayout ? 'channel-calendar-content' : 'channel-events-panel'}
      className={isMainLayout
        ? 'flex min-h-0 min-w-0 flex-1 flex-col bg-background'
        : 'w-full md:w-80 md:max-w-[85vw] absolute inset-y-0 right-0 z-20 md:static bg-[hsl(var(--background))] md:bg-card/30 border-l border-white/5 flex flex-col flex-shrink-0 shadow-2xl md:shadow-none'}
    >
      <div className="h-12 border-b border-white/5 flex items-center px-4 justify-between flex-shrink-0 bg-card/30 backdrop-blur-sm">
        <div className="flex items-center gap-2 text-foreground font-medium">
          <Calendar className="w-4 h-4 text-primary" />
          <span>{isMainLayout ? 'Calendario de eventos' : 'Eventos'}</span>
        </div>
        <div className="flex items-center gap-1">
          {view === 'list' && (
            <button type="button"
              onClick={() => setView('create')}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
              title="Crear evento"
              aria-label="Crear evento"
              data-testid="button-create-event"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>Crear evento</span>
            </button>
          )}
          {!isMainLayout && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-muted-foreground hover:text-white hover:bg-white/5 rounded-md transition-colors"
              aria-label="Cerrar eventos"
            >
              <XIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {view === 'list' && (
          <div className="space-y-6">
            <div className="text-[10px] text-muted-foreground/80 bg-white/5 p-2 rounded leading-relaxed border border-white/5">
              <AlertCircle className="w-3 h-3 inline-block mr-1 -mt-0.5" />
              Avisos solo mientras la app está abierta; sin notificaciones push con la app cerrada.
            </div>

            <div>
              <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">Próximos</h3>
              {isLoading ? (
                <div className="space-y-3">
                  {[1, 2].map(i => <div key={i} className="h-24 bg-white/5 animate-pulse rounded-lg" />)}
                </div>
              ) : upcomingEvents.length === 0 ? (
                <div className="text-center p-4 bg-white/5 rounded-lg border border-white/5 border-dashed">
                  <CalendarPlus className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">No hay eventos próximos</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {upcomingEvents.map(event => (
                    <EventItem 
                      key={event.id} 
                      event={event} 
                      channelId={channelId}
                      canManage={canManage(event.creatorId)}
                      onEdit={() => { setEditingEvent(event); setView('edit'); }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">Pasados / Cancelados</h3>
              {pastEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No hay eventos pasados</p>
              ) : (
                <div className="space-y-3 opacity-60 hover:opacity-100 transition-opacity">
                  {pastEvents.map(event => (
                    <EventItem 
                      key={event.id} 
                      event={event} 
                      channelId={channelId}
                      canManage={canManage(event.creatorId)}
                      onEdit={() => { setEditingEvent(event); setView('edit'); }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {(view === 'create' || view === 'edit') && (
          <EventForm 
            channelId={channelId} 
            event={view === 'edit' ? editingEvent : null}
            onCancel={() => { setView('list'); setEditingEvent(null); }}
            onSuccess={() => { setView('list'); setEditingEvent(null); }}
          />
        )}
      </div>
    </div>
  );
}

function EventItem({ event, channelId, canManage, onEdit }: { event: any, channelId: number, canManage: boolean, onEdit: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const { formattedLocal, ianaLocal, formattedOrigin, ianaOrigin } = formatEventTime(event.startsAt, event.originalTimeZone);
  
  const { toast } = useToast();
  const { mutate: respond } = useRespondToChannelEvent();
  const { mutate: cancelEvent } = useCancelChannelEvent();

  const queryClient = useQueryClient();
  const handleRSVP = (status: 'yes' | 'no' | 'maybe') => {
    respond({ channelId, eventId: event.id, data: { status } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetChannelEventQueryKey(channelId, event.id) });
        queryClient.invalidateQueries({ queryKey: getListChannelEventsQueryKey(channelId) });
        queryClient.invalidateQueries({ queryKey: getListMyUpcomingEventsQueryKey() });
      },
      onError: () => {
        toast({
          title: "Error al enviar RSVP",
          description: "No se pudo actualizar tu respuesta. Inténtalo de nuevo.",
          variant: "destructive"
        });
      }
    });
  };

  const isPast = new Date(event.startsAt) < new Date();
  
  return (
    <div
      data-testid={`event-item-${event.id}`}
      className={`bg-secondary/40 border ${event.canceledAt ? 'border-destructive/30' : 'border-white/10'} rounded-lg overflow-hidden flex flex-col`}
    >
      <div 
        className="p-3 cursor-pointer hover:bg-white/5 transition-colors group focus:outline-none focus:ring-2 focus:ring-primary/50"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-2 mb-1">
          <h4 className={`font-medium text-sm leading-tight ${event.canceledAt ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
            {event.title}
          </h4>
          <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
        
        <div className="text-xs text-primary/80 flex items-center gap-1.5 mb-2">
          <Clock className="w-3 h-3" />
          <span>{formattedLocal} ({ianaLocal})</span>
        </div>

        <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
          <span className={`flex items-center gap-1 ${event.myResponse?.status === 'yes' ? 'text-primary' : ''}`} title="Asistirán">
            <Check className="w-3 h-3" aria-label="Asistirán" /> {event.counts.yes}
          </span>
          <span className={`flex items-center gap-1 ${event.myResponse?.status === 'maybe' ? 'text-foreground' : ''}`} title="Tal vez">
            <HelpCircle className="w-3 h-3" aria-label="Tal vez" /> {event.counts.maybe}
          </span>
          <span className={`flex items-center gap-1 ${event.myResponse?.status === 'no' ? 'text-destructive' : ''}`} title="No asistirán">
            <XIcon className="w-3 h-3" aria-label="No asistirán" /> {event.counts.no}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-white/5 bg-black/20">
          {event.description && (
            <p className="text-xs text-foreground/80 whitespace-pre-wrap mb-3 leading-relaxed">
              {event.description}
            </p>
          )}

          <div className="space-y-1 mb-4 text-[10px] text-muted-foreground/70 bg-black/20 p-2 rounded">
            <p><strong>Organiza:</strong> {event.creator.displayName}</p>
            <p><strong>Zona horaria (tú):</strong> {ianaLocal}</p>
            {formattedOrigin && (
              <p><strong>Zona de referencia:</strong> {ianaOrigin} ({formattedOrigin})</p>
            )}
            {event.endsAt && (
              <p><strong>Termina:</strong> {formatEventTime(event.endsAt, event.originalTimeZone).formattedLocal} ({ianaLocal})</p>
            )}
          </div>

          {!event.canceledAt && !isPast && (
            <div className="mb-4">
              <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">Tu respuesta</p>
              <div className="flex gap-1">
                <button 
                  onClick={() => handleRSVP('yes')}
                  aria-label="Responder Asistiré"
                  data-testid={`button-rsvp-yes-${event.id}`}
                  className={`flex-1 py-1.5 text-xs rounded transition-colors ${event.myResponse?.status === 'yes' ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}
                >
                  Asistiré
                </button>
                <button 
                  onClick={() => handleRSVP('maybe')}
                  aria-label="Responder Tal vez"
                  data-testid={`button-rsvp-maybe-${event.id}`}
                  className={`flex-1 py-1.5 text-xs rounded transition-colors ${event.myResponse?.status === 'maybe' ? 'bg-secondary text-foreground border border-white/20' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}
                >
                  Tal vez
                </button>
                <button 
                  onClick={() => handleRSVP('no')}
                  aria-label="Responder No asistiré"
                  data-testid={`button-rsvp-no-${event.id}`}
                  className={`flex-1 py-1.5 text-xs rounded transition-colors ${event.myResponse?.status === 'no' ? 'bg-destructive/20 text-destructive border border-destructive/30' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}
                >
                  No
                </button>
              </div>
            </div>
          )}

          {/* Attendees List */}
          {event.responses && event.responses.length > 0 && (
            <div className="mb-4 space-y-2">
              {['yes', 'maybe', 'no'].map((status) => {
                const attendees = event.responses.filter((r: any) => r.status === status);
                if (attendees.length === 0) return null;
                
                let Icon = Check;
                let colorClass = "text-primary";
                let label = "Asistirán";
                if (status === 'maybe') { Icon = HelpCircle; colorClass = "text-foreground/70"; label = "Tal vez"; }
                if (status === 'no') { Icon = XIcon; colorClass = "text-destructive"; label = "No asistirán"; }

                return (
                  <div key={status}>
                    <p className={`text-[10px] font-mono flex items-center gap-1 ${colorClass} mb-1`}>
                      <Icon className="w-3 h-3" /> {label} ({attendees.length})
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {attendees.map((r: any) => (
                        <div key={r.userId} className="flex items-center gap-1 bg-white/5 border border-white/5 rounded-full px-1.5 py-0.5" title={r.user.name}>
                          {r.user.avatarUrl ? (
                            <img src={sameOriginUploadUrl(r.user.avatarUrl)} alt="" className="w-3 h-3 rounded-full object-cover" />
                          ) : (
                            <UsersIcon className="w-3 h-3 text-muted-foreground p-0.5" />
                          )}
                          <span className="text-[10px] text-foreground/80">{r.user.displayName}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {canManage && !event.canceledAt && !isPast && (
            <div className="flex gap-2 pt-2 border-t border-white/5">
              <button 
                onClick={onEdit}
                className="text-[10px] font-medium px-2 py-1 rounded bg-white/5 text-foreground hover:bg-white/10 transition-colors"
              >
                Editar
              </button>
              <button 
                onClick={() => {
                  if (confirm('¿Estás seguro de cancelar este evento?')) {
                    cancelEvent({ channelId, eventId: event.id }, {
                      onSuccess: () => {
                        queryClient.invalidateQueries({ queryKey: getGetChannelEventQueryKey(channelId, event.id) });
                        queryClient.invalidateQueries({ queryKey: getListChannelEventsQueryKey(channelId) });
                        queryClient.invalidateQueries({ queryKey: getListMyUpcomingEventsQueryKey() });
                        queryClient.invalidateQueries({ queryKey: [`/api/channels/${channelId}/messages`] });
                      },
                      onError: () => {
                        toast({
                          title: "Error",
                          description: "No se pudo cancelar el evento.",
                          variant: "destructive"
                        });
                      }
                    });
                  }
                }}
                className="text-[10px] font-medium px-2 py-1 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
              >
                Cancelar Evento
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventForm({ channelId, event, onCancel, onSuccess }: { channelId: number, event?: any, onCancel: () => void, onSuccess: () => void }) {
  const [title, setTitle] = useState(event?.title || '');
  const [description, setDescription] = useState(event?.description || '');
  
  // Format dates for datetime-local input (YYYY-MM-DDThh:mm)
  const formatForInput = (isoDate: string) => {
    if (!isoDate) return '';
    const d = new Date(isoDate);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const [startsAt, setStartsAt] = useState(event ? formatForInput(event.startsAt) : '');
  const [endsAt, setEndsAt] = useState(event?.endsAt ? formatForInput(event.endsAt) : '');
  const [error, setError] = useState('');

  const { mutate: create, isPending: isCreating } = useCreateChannelEvent();
  const { mutate: update, isPending: isUpdating } = useUpdateChannelEvent();
  const queryClient = useQueryClient();

  const isPending = isCreating || isUpdating;

  const invalidateQueries = (eventId?: number) => {
    queryClient.invalidateQueries({ queryKey: getListChannelEventsQueryKey(channelId) });
    queryClient.invalidateQueries({ queryKey: getListMyUpcomingEventsQueryKey() });
    queryClient.invalidateQueries({ queryKey: [`/api/channels/${channelId}/messages`] });
    if (eventId) {
      queryClient.invalidateQueries({ queryKey: getGetChannelEventQueryKey(channelId, eventId) });
    }
  };

  const startValidation = validateLocalTime(startsAt);
  const endValidation = endsAt ? validateLocalTime(endsAt) : { valid: true };
  
  let timesChanged = false;
  try {
    timesChanged = event && startValidation.valid && endValidation.valid && (
      event.startsAt !== convertToUTC(startsAt) ||
      (event.endsAt || null) !== (endsAt ? convertToUTC(endsAt) : null)
    );
  } catch (e) {
    // ignore parsing error during render for warning calculation
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!title.trim() || title.length > 120) {
      return setError('El título debe tener entre 1 y 120 caracteres.');
    }
    if (description.length > 2000) {
      return setError('La descripción es demasiado larga.');
    }
    
    if (!startValidation.valid) {
      return setError(`Inicio: ${startValidation.error}`);
    }
    if (endsAt && !endValidation.valid) {
      return setError(`Fin: ${endValidation.error}`);
    }

    try {
      const startUtc = convertToUTC(startsAt);
      const startD = new Date(startUtc);
      
      if (startD <= new Date()) {
        return setError('La fecha de inicio debe ser en el futuro.');
      }

      let endUtc: string | null = null;
      if (endsAt) {
        endUtc = convertToUTC(endsAt);
        const endD = new Date(endUtc);
        if (endD <= startD) {
          return setError('La fecha de fin debe ser posterior a la de inicio.');
        }
        if (endD.getTime() - startD.getTime() > 7 * 24 * 60 * 60 * 1000) {
          return setError('El evento no puede durar más de 7 días.');
        }
      }

      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        startsAt: startUtc,
        endsAt: endUtc,
        originalTimeZone: (event && !timesChanged) ? event.originalTimeZone : Intl.DateTimeFormat().resolvedOptions().timeZone
      };

      if (event) {
        update({ channelId, eventId: event.id, data: payload }, { 
          onSuccess: () => {
            invalidateQueries(event.id);
            onSuccess();
          },
          onError: () => setError('No se pudo actualizar el evento. Comprueba los datos e inténtalo de nuevo.'),
        });
      } else {
        create({ channelId, data: payload }, { 
          onSuccess: () => {
            invalidateQueries();
            onSuccess();
          },
          onError: () => setError('No se pudo crear el evento. Comprueba los datos e inténtalo de nuevo.'),
        });
      }
    } catch (err) {
      setError('Error al procesar las fechas.');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <button type="button" onClick={onCancel} className="p-1 -ml-1 text-muted-foreground hover:text-white rounded">
          <ChevronRight className="w-4 h-4 rotate-180" />
        </button>
        <h3 className="font-medium text-foreground">{event ? 'Editar Evento' : 'Nuevo Evento'}</h3>
      </div>

      {event && timesChanged && (
        <div className="text-[10px] text-accent-foreground bg-accent/20 p-2 rounded border border-white/10 leading-relaxed">
          <AlertCircle className="w-3 h-3 inline-block mr-1 -mt-0.5" />
          Editar las fechas reiniciará todas las respuestas (RSVPs) existentes.
        </div>
      )}

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 p-2 rounded">{error}</div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Título</label>
        <input 
          type="text" 
          data-testid="input-event-title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={120}
          className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary transition-colors"
          placeholder="Ej: Noche de películas"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Inicio</label>
        <input 
          type="datetime-local" 
          data-testid="input-event-starts-at"
          value={startsAt}
          onChange={e => setStartsAt(e.target.value)}
          className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary transition-colors [color-scheme:dark]"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Fin (opcional)</label>
        <input 
          type="datetime-local" 
          value={endsAt}
          onChange={e => setEndsAt(e.target.value)}
          className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary transition-colors [color-scheme:dark]"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Descripción</label>
        <textarea 
          value={description}
          onChange={e => setDescription(e.target.value)}
          maxLength={2000}
          rows={4}
          className="w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary transition-colors resize-none"
          placeholder="Detalles adicionales..."
        />
      </div>

      <div className="pt-2 flex gap-2">
        <button 
          type="button"
          onClick={onCancel}
          className="flex-1 py-2 rounded text-sm font-medium text-foreground bg-white/5 hover:bg-white/10 transition-colors"
        >
          Cancelar
        </button>
        <button 
          type="submit"
          data-testid="button-save-event"
          disabled={isPending}
          className="flex-1 py-2 rounded text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {isPending ? 'Guardando...' : 'Guardar'}
        </button>
      </div>
    </form>
  );
}
