import { useCallback, useEffect, useState } from 'react';
import {
  createAdminGroupRoleMapping,
  createAdminRole,
  deleteAdminGroupRoleMapping,
  deleteAdminRole,
  fetchAdminGroupRoleMappings,
  fetchAdminRoles,
  type AdminGroupRoleMapping,
  type AdminRole,
  type EffectiveAdminPermissions,
} from '../api/client';

type PermissionsStatus = 'loading' | 'ready' | 'failed';

const CONNECTOR_TYPES = [
  'zabbix',
  'cmdbuild',
  'passwork',
  'consultant-plus',
  'postgres-role',
  'mssql-login',
  'linux',
  'rest',
  'db',
  'fake',
];

interface RoleForm {
  code: string;
  name: string;
  description: string;
  connectorType: string;
  canRead: boolean;
  canWrite: boolean;
}

interface MappingForm {
  idpGroup: string;
  roleId: string;
}

export function RbacPage({
  authEnabled = true,
  effective,
  permissionsStatus = 'ready',
}: {
  authEnabled?: boolean;
  effective: EffectiveAdminPermissions | null;
  permissionsStatus?: PermissionsStatus;
}) {
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [mappings, setMappings] = useState<AdminGroupRoleMapping[]>([]);
  const [roleForm, setRoleForm] = useState<RoleForm>({
    code: '',
    name: '',
    description: '',
    connectorType: 'zabbix',
    canRead: true,
    canWrite: false,
  });
  const [mappingForm, setMappingForm] = useState<MappingForm>({
    idpGroup: '',
    roleId: '',
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const [rolesData, mappingsData] = await Promise.all([
        fetchAdminRoles(),
        fetchAdminGroupRoleMappings(),
      ]);
      setRoles(rolesData);
      setMappings(mappingsData);
      setMappingForm((current) => ({
        ...current,
        roleId: current.roleId || rolesData[0]?.id || '',
      }));
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const saveRole = async () => {
    setSaving(true);
    setMessage('');
    try {
      await createAdminRole({
        code: roleForm.code,
        name: roleForm.name,
        description: roleForm.description || undefined,
        enabled: true,
        permissions: [
          {
            connectorType: roleForm.connectorType,
            canRead: roleForm.canRead,
            canWrite: roleForm.canWrite,
          },
        ],
      });
      setRoleForm({
        code: '',
        name: '',
        description: '',
        connectorType: roleForm.connectorType,
        canRead: true,
        canWrite: false,
      });
      await load();
      setMessage('Role created');
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const saveMapping = async () => {
    setSaving(true);
    setMessage('');
    try {
      await createAdminGroupRoleMapping({
        idpGroup: mappingForm.idpGroup,
        roleId: mappingForm.roleId,
        enabled: true,
      });
      setMappingForm({ idpGroup: '', roleId: mappingForm.roleId });
      await load();
      setMessage('Mapping created');
    } catch (e: unknown) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const canManageRbac =
    !authEnabled ||
    (permissionsStatus === 'ready' && effective?.superadmin === true);

  if (!canManageRbac) {
    const message =
      permissionsStatus === 'loading'
        ? 'Loading RBAC permissions.'
        : permissionsStatus === 'failed'
          ? 'Cannot load RBAC permissions.'
          : 'Superadmin permission required.';
    return (
      <div className="page-shell">
        <h1>RBAC</h1>
        <div className="error-text">{message}</div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="page-title-row">
        <h1>RBAC</h1>
        <button className="button" onClick={load} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {message && <div className="message">{message}</div>}

      <section className="panel">
        <h2>Effective permissions</h2>
        <div className="status-strip compact-status">
          <div className="status-item">
            <span className="status-label">Provider</span>
            <span className="status-value">{effective?.provider ?? '-'}</span>
          </div>
          <div className="status-item">
            <span className="status-label">Superadmin</span>
            <span className="status-value">
              {effective?.superadmin ? 'yes' : 'no'}
            </span>
          </div>
          <div className="status-item">
            <span className="status-label">Groups</span>
            <span className="status-value">
              {effective?.groups.length ?? 0}
            </span>
          </div>
          <div className="status-item">
            <span className="status-label">Roles</span>
            <span className="status-value">{effective?.roles.length ?? 0}</span>
          </div>
        </div>
        <table className="data-table compact-table">
          <thead>
            <tr>
              <th>Connector type</th>
              <th>Read</th>
              <th>Write</th>
            </tr>
          </thead>
          <tbody>
            {(effective?.permissions ?? []).map((permission) => (
              <tr key={permission.connectorType}>
                <td className="mono">{permission.connectorType}</td>
                <td>{permission.canRead ? 'yes' : 'no'}</td>
                <td>{permission.canWrite ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Roles</h2>
        <div className="form-grid">
          <label>
            Code
            <input
              value={roleForm.code}
              onChange={(e) =>
                setRoleForm({ ...roleForm, code: e.target.value })
              }
            />
          </label>
          <label>
            Name
            <input
              value={roleForm.name}
              onChange={(e) =>
                setRoleForm({ ...roleForm, name: e.target.value })
              }
            />
          </label>
          <label>
            Connector type
            <select
              value={roleForm.connectorType}
              onChange={(e) =>
                setRoleForm({ ...roleForm, connectorType: e.target.value })
              }
            >
              {CONNECTOR_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label>
            Description
            <input
              value={roleForm.description}
              onChange={(e) =>
                setRoleForm({ ...roleForm, description: e.target.value })
              }
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={roleForm.canRead}
              onChange={(e) =>
                setRoleForm({ ...roleForm, canRead: e.target.checked })
              }
            />
            Read
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={roleForm.canWrite}
              onChange={(e) =>
                setRoleForm({ ...roleForm, canWrite: e.target.checked })
              }
            />
            Write
          </label>
          <button
            className="button primary"
            onClick={() => void saveRole()}
            disabled={saving}
          >
            Add role
          </button>
        </div>
        <table className="data-table compact-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Permissions</th>
              <th>Enabled</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.id}>
                <td className="mono">{role.code}</td>
                <td>{role.name}</td>
                <td>
                  {role.permissions
                    .map(
                      (permission) =>
                        `${permission.connectorType}:${permission.canWrite ? 'write' : 'read'}`,
                    )
                    .join(', ')}
                </td>
                <td>{role.enabled ? 'yes' : 'no'}</td>
                <td>
                  <button
                    className="button danger small"
                    onClick={() => void deleteAdminRole(role.id).then(load)}
                    disabled={saving || role.system}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>IdP group mappings</h2>
        <div className="form-grid">
          <label>
            IdP group
            <input
              value={mappingForm.idpGroup}
              onChange={(e) =>
                setMappingForm({ ...mappingForm, idpGroup: e.target.value })
              }
            />
          </label>
          <label>
            Role
            <select
              value={mappingForm.roleId}
              onChange={(e) =>
                setMappingForm({ ...mappingForm, roleId: e.target.value })
              }
            >
              <option value="">Select role</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.code}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            onClick={() => void saveMapping()}
            disabled={saving || !mappingForm.roleId}
          >
            Add mapping
          </button>
        </div>
        <table className="data-table compact-table">
          <thead>
            <tr>
              <th>IdP group</th>
              <th>Role</th>
              <th>Enabled</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((mapping) => (
              <tr key={mapping.id}>
                <td className="mono">{mapping.idpGroup}</td>
                <td>{mapping.role?.code ?? mapping.roleId}</td>
                <td>{mapping.enabled ? 'yes' : 'no'}</td>
                <td>
                  <button
                    className="button danger small"
                    onClick={() =>
                      void deleteAdminGroupRoleMapping(mapping.id).then(load)
                    }
                    disabled={saving}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
