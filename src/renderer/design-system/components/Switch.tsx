import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'

import { FieldFrame, useFieldFrame } from '../internal/FieldFrame'
import { classNames } from '../internal/classNames'

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  busy?: boolean
  description?: ReactNode
  error?: ReactNode
  label: ReactNode
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  {
    busy = false,
    className,
    description,
    disabled,
    error,
    id,
    label,
    required,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    ...inputProps
  },
  ref
) {
  const field = useFieldFrame({ id, describedBy: ariaDescribedBy, description, error })

  return (
    <FieldFrame
      className="fui-field--switch"
      description={description}
      error={error}
      label={label}
      required={required}
      state={field}
    >
      <span aria-busy={busy || undefined} className="fui-switch">
        <input
          {...inputProps}
          aria-describedby={field.describedBy}
          aria-invalid={field.invalid ? true : ariaInvalid}
          className={classNames('fui-switch__input', className)}
          disabled={disabled || busy}
          id={field.controlId}
          ref={ref}
          required={required}
          type="checkbox"
        />
        <span aria-hidden="true" className="fui-switch__track">
          <span className="fui-switch__thumb" />
        </span>
      </span>
    </FieldFrame>
  )
})
