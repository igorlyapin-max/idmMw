-- CreateTable
CREATE TABLE "AdminRole" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRoleConnectorPermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "connectorType" TEXT NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminRoleConnectorPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminGroupRoleMapping" (
    "id" TEXT NOT NULL,
    "idpGroup" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminGroupRoleMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminRole_code_key" ON "AdminRole"("code");

-- CreateIndex
CREATE INDEX "AdminRole_enabled_idx" ON "AdminRole"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRoleConnectorPermission_roleId_connectorType_key" ON "AdminRoleConnectorPermission"("roleId", "connectorType");

-- CreateIndex
CREATE INDEX "AdminRoleConnectorPermission_connectorType_idx" ON "AdminRoleConnectorPermission"("connectorType");

-- CreateIndex
CREATE UNIQUE INDEX "AdminGroupRoleMapping_idpGroup_roleId_key" ON "AdminGroupRoleMapping"("idpGroup", "roleId");

-- CreateIndex
CREATE INDEX "AdminGroupRoleMapping_idpGroup_enabled_idx" ON "AdminGroupRoleMapping"("idpGroup", "enabled");

-- AddForeignKey
ALTER TABLE "AdminRoleConnectorPermission" ADD CONSTRAINT "AdminRoleConnectorPermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminGroupRoleMapping" ADD CONSTRAINT "AdminGroupRoleMapping_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
