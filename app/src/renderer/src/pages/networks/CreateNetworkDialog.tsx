import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { navigate } from '@/lib/router'

const octet = String.raw`(25[0-5]|2[0-4]\d|1?\d?\d)`
const ip4 = new RegExp(String.raw`^${octet}(\.${octet}){3}$`)
const cidr4 = new RegExp(String.raw`^${octet}(\.${octet}){3}/(3[0-2]|[12]?\d)$`)

type Field = 'name' | 'subnet' | 'gateway' | 'form'

/** A new bridge network. Docker picks the address range unless one is given. */
export function CreateNetworkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [internal, setInternal] = useState(false)
  const [subnet, setSubnet] = useState('')
  const [gateway, setGateway] = useState('')
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setName('')
      setInternal(false)
      setSubnet('')
      setGateway('')
      setErrors({})
    }
  }, [open])

  const check = () => {
    const e: Partial<Record<Field, string>> = {}
    if (!name.trim()) e.name = 'Give the network a name.'
    else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name.trim())) e.name = 'Use at least two characters: letters, digits, dots, dashes or underscores, starting with a letter or digit.'
    if (subnet.trim() && !cidr4.test(subnet.trim())) e.subnet = 'Write it as an IPv4 range, like 172.30.0.0/24.'
    if (gateway.trim() && !ip4.test(gateway.trim())) e.gateway = 'Write it as an IPv4 address, like 172.30.0.1.'
    else if (gateway.trim() && !subnet.trim()) e.gateway = 'A gateway needs a subnet.'
    setErrors(e)
    return !Object.keys(e).length
  }

  const submit = async () => {
    if (!check()) return
    setBusy(true)
    try {
      const n = await api.networks.create({
        name: name.trim(),
        internal,
        ...(subnet.trim() ? { subnet: subnet.trim() } : {}),
        ...(gateway.trim() ? { gateway: gateway.trim() } : {}),
      })
      toast({ kind: 'success', title: `Created ${n.name}`, body: n.subnet ? `Addresses come from ${n.subnet}.` : undefined })
      onClose()
      navigate('networks', n.id)
    } catch (e) {
      const message = (e as Error).message
      setErrors(/already exists/.test(message) ? { name: message } : /overlap|subnet|range/i.test(message) ? { subnet: message } : { form: message })
    } finally {
      setBusy(false)
    }
  }

  const clear = (f: Field) => setErrors((e) => ({ ...e, [f]: undefined, form: undefined }))

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Create a network"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Plus />} loading={busy} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Input
          label="Name"
          placeholder="backend"
          value={name}
          onChange={(e) => (setName(e.target.value), clear('name'))}
          error={errors.name}
          hint="Containers on the same network reach each other by name."
          autoComplete="off"
          spellCheck={false}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Subnet (optional)" placeholder="172.30.0.0/24" value={subnet} onChange={(e) => (setSubnet(e.target.value), clear('subnet'))} error={errors.subnet} autoComplete="off" spellCheck={false} />
          <Input label="Gateway (optional)" placeholder="172.30.0.1" value={gateway} onChange={(e) => (setGateway(e.target.value), clear('gateway'))} error={errors.gateway} autoComplete="off" spellCheck={false} />
        </div>
        <div className="flex flex-col gap-1">
          <Switch label="Internal only" checked={internal} onCheckedChange={setInternal} />
          <p className="text-sm text-muted">Containers on it can talk to each other but not to the internet.</p>
        </div>
        {errors.form && (
          <p role="alert" className="text-sm text-danger">
            {errors.form}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
