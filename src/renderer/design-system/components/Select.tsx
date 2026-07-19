import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react'

import { FieldFrame, useFieldFrame } from '../internal/FieldFrame'
import { classNames } from '../internal/classNames'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  description?: ReactNode
  error?: ReactNode
  label: ReactNode
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    children,
    className,
    description,
    error,
    id,
    label,
    required,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    ...selectProps
  },
  ref
) {
  const field = useFieldFrame({ id, describedBy: ariaDescribedBy, description, error })

  return (
    <FieldFrame description={description} error={error} label={label} required={required} state={field}>
      <select
        {...selectProps}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid ? true : ariaInvalid}
        className={classNames('fui-field__control', 'fui-select', className)}
        id={field.controlId}
        ref={ref}
        required={required}
      >
        {children}
      </select>
    </FieldFrame>
  )
})
