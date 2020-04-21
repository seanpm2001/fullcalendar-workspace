import { EventMutation, Hit, EventDef, ReducerContext } from '@fullcalendar/core'


export function massageEventDragMutation(eventMutation: EventMutation, hit0: Hit, hit1: Hit) {
  let resource0 = hit0.dateSpan.resourceId
  let resource1 = hit1.dateSpan.resourceId

  if (
    resource0 && resource1 &&
    resource0 !== resource1
  ) {
    eventMutation.resourceMutation = {
      matchResourceId: resource0,
      setResourceId: resource1
    }
  }
}


/*
TODO: all this would be much easier if we were using a hash!
*/
export function applyEventDefMutation(eventDef: EventDef, mutation: EventMutation, context: ReducerContext) {
  let resourceMutation = mutation.resourceMutation

  if (resourceMutation && computeResourceEditable(eventDef, context)) {
    let index = eventDef.resourceIds.indexOf(resourceMutation.matchResourceId)

    if (index !== -1) {
      let resourceIds = eventDef.resourceIds.slice() // copy

      resourceIds.splice(index, 1) // remove

      if (resourceIds.indexOf(resourceMutation.setResourceId) === -1) { // not already in there
        resourceIds.push(resourceMutation.setResourceId) // add
      }

      eventDef.resourceIds = resourceIds
    }
  }
}


/*
HACK
TODO: use EventUi system instead of this
*/
export function computeResourceEditable(eventDef: EventDef, context: ReducerContext): boolean {
  let { resourceEditable } = eventDef

  if (resourceEditable == null) {
    let source = eventDef.sourceId && context.getCurrentState().eventSources[eventDef.sourceId]

    if (source) {
      resourceEditable = source.extendedProps.resourceEditable // used the Source::extendedProps hack
    }

    if (resourceEditable == null) {
      resourceEditable = context.options.eventResourceEditable

      if (resourceEditable == null) {
        resourceEditable = context.options.editable // TODO: use defaults system instead
      }
    }
  }

  return resourceEditable
}


export function transformEventDrop(mutation: EventMutation, context: ReducerContext) {
  let { resourceMutation } = mutation

  if (resourceMutation) {
    let { calendarApi } = context

    return {
      oldResource: calendarApi.getResourceById(resourceMutation.matchResourceId),
      newResource: calendarApi.getResourceById(resourceMutation.setResourceId)
    }

  } else {
    return {
      oldResource: null,
      newResource: null
    }
  }
}
