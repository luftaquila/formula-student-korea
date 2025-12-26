import { Notyf } from 'notyf'

let notyfInstance = null

function getNotyf() {
  if (!notyfInstance) {
    notyfInstance = new Notyf({
      ripple: false,
      duration: 3500,
      types: [
        {
          type: 'warn',
          background: 'orange',
          icon: {
            className: 'fa fa-exclamation-triangle',
            tagName: 'i',
            color: 'white'
          }
        }
      ]
    })
  }
  return notyfInstance
}

export function useNotification() {
  const notyf = getNotyf()

  return {
    notyf,
    success: (message) => notyf.success(message),
    error: (message) => notyf.error(message),
    warn: (message) => notyf.open({ type: 'warn', message })
  }
}
