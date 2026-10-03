-- CreateTable
CREATE TABLE "LinuxCredentialProfile" (
    "id" TEXT NOT NULL,
    "targetSystemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "privateKeyRef" TEXT,
    "passwordRef" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinuxCredentialProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinuxHost" (
    "id" TEXT NOT NULL,
    "targetSystemId" TEXT NOT NULL,
    "credentialProfileId" TEXT,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "hostFingerprint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinuxHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinuxServerGroup" (
    "id" TEXT NOT NULL,
    "targetSystemId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinuxServerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinuxServerGroupHost" (
    "groupId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,

    CONSTRAINT "LinuxServerGroupHost_pkey" PRIMARY KEY ("groupId","hostId")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinuxCredentialProfile_targetSystemId_name_key" ON "LinuxCredentialProfile"("targetSystemId", "name");

-- CreateIndex
CREATE INDEX "LinuxCredentialProfile_targetSystemId_enabled_idx" ON "LinuxCredentialProfile"("targetSystemId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "LinuxHost_targetSystemId_name_key" ON "LinuxHost"("targetSystemId", "name");

-- CreateIndex
CREATE INDEX "LinuxHost_targetSystemId_enabled_idx" ON "LinuxHost"("targetSystemId", "enabled");

-- CreateIndex
CREATE INDEX "LinuxHost_credentialProfileId_idx" ON "LinuxHost"("credentialProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "LinuxServerGroup_targetSystemId_code_key" ON "LinuxServerGroup"("targetSystemId", "code");

-- CreateIndex
CREATE INDEX "LinuxServerGroup_targetSystemId_enabled_idx" ON "LinuxServerGroup"("targetSystemId", "enabled");

-- CreateIndex
CREATE INDEX "LinuxServerGroupHost_hostId_idx" ON "LinuxServerGroupHost"("hostId");

-- AddForeignKey
ALTER TABLE "LinuxCredentialProfile" ADD CONSTRAINT "LinuxCredentialProfile_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinuxHost" ADD CONSTRAINT "LinuxHost_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinuxHost" ADD CONSTRAINT "LinuxHost_credentialProfileId_fkey" FOREIGN KEY ("credentialProfileId") REFERENCES "LinuxCredentialProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinuxServerGroup" ADD CONSTRAINT "LinuxServerGroup_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinuxServerGroupHost" ADD CONSTRAINT "LinuxServerGroupHost_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LinuxServerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinuxServerGroupHost" ADD CONSTRAINT "LinuxServerGroupHost_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "LinuxHost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
