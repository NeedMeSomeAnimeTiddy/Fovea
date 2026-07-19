import { useId, type ReactNode } from 'react'

import { classNames } from './classNames'

function hasContent(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false && value !== ''
}

export function mergeDescribedBy(...values: Array<string | undefined>): string | undefined {
  const ids = values.flatMap((value) => value?.trim().split(/\s+/) ?? []).filter(Boolean)
  const uniqueIds = [...new Set(ids)]

  return uniqueIds.length > 0 ? uniqueIds.join(' ') : undefined
}

export interface FieldFrameState {
  controlId: string
  descriptionId?: string
  errorId?: string
  describedBy?: string
  invalid: boolean
}

interface UseFieldFrameOptions {
  id?: string
  describedBy?: string
  description?: ReactNode
  error?: ReactNode
}

export function useFieldFrame({ id, describedBy, description, error }: UseFieldFrameOptions): FieldFrameState {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const controlId = id ?? `fui-field-${generatedId}`
  const descriptionId = hasContent(description) ? `${controlId}-description` : undefined
  const errorId = hasContent(error) ? `${controlId}-error` : undefined

  return {
    controlId,
    descriptionId,
    errorId,
    describedBy: mergeDescribedBy(describedBy, descriptionId, errorId),
    invalid: errorId !== undefined
  }
}

interface FieldFrameProps {
  children: ReactNode
  className?: string
  description?: ReactNode
  error?: ReactNode
  label: ReactNode
  required?: boolean
  state: FieldFrameState
}

export function FieldFrame({
  children,
  className,
  description,
  error,
  label,
  required,
  state
}: FieldFrameProps): React.JSX.Element {
  return (
    <div className={classNames('fui-field', className)}>
      <label className="fui-field__label" htmlFor={state.controlId}>
        <span>{label}</span>
        {required ? <span className="fui-field__required">Required</span> : null}
      </label>
      {state.descriptionId ? (
        <div className="fui-field__description" id={state.descriptionId}>
          {description}
        </div>
      ) : null}
      {children}
      {state.errorId ? (
        <div className="fui-field__error" id={state.errorId}>
          <span aria-hidden="true" className="fui-field__error-mark">
            !
          </span>
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  )
}
